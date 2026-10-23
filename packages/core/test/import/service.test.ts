/**
 * The import service on a real engine with a scripted model
 * (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 1.15): scan, estimate, import
 * only, re-import, a grown source, Conclave's own harness turns, both sides
 * grown (a fork), learning with checks in code, undo, the review queue,
 * uploads, a model limit, and the older single import.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { appendFileSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine, type RequestBody, type TestEngine } from '../engine/harness';
import { importOf } from '../../src/import/registry';
import type { ImportService } from '../../src/import/service';
import type { ExternalSessionInfo, SessionImportInfo } from '../../src/client/import';
import type { Message, Session } from '../../src/types';
import { newId } from '../../src/util/ids';
import type { SqliteMemory } from '../../src/memory/store';
import { buildOwnerHome, chatGptExport, claudeAiExport, growClaudeA, OWNER, zipOf, type OwnerHome } from '../importers/owner-home';

let t: TestEngine;
let svc: ImportService;
let h: OwnerHome;
const saved: Record<string, string | undefined> = {};
/** Learn prompts the scripted model saw. */
const learnPrompts: string[] = [];
let limitNext = false;

const sys = (body: RequestBody) => JSON.stringify(body.system ?? '');
const lastUser = (body: RequestBody) => JSON.stringify(body.messages ?? []);

/** The scripted learning model: answers by the session title in the prompt. */
function chore(body: RequestBody): Array<{ text: string }> | number | undefined {
  const s = sys(body);
  const p = lastUser(body);
  if (s.includes('You turn one past session into memory')) {
    if (limitNext) {
      limitNext = false;
      return 429;
    }
    learnPrompts.push(p);
    if (p.includes('Portfolio contact form')) {
      const old = /\[(mem_[A-Za-z0-9_-]+)\] \(fact, project\) The portfolio launch is on 2026-03-01/.exec(JSON.parse(p)[0].content[0].text)?.[1] ?? '';
      return [
        {
          text: JSON.stringify({
            episode: 'Built the portfolio contact form with Resend, zod and a honeypot.\nDeployed with bun run deploy.',
            items: [
              { kind: 'procedure', content: 'The user deploys the portfolio with bun run deploy from the repo root, never from CI.', scope: 'project', subject: 'portfolio', evidence: 'I always deploy the portfolio with `bun run deploy` from the repo root, never from CI', basis: 'user_said', supersedes: '' },
              { kind: 'preference', content: 'The user prefers Resend over nodemailer for email.', scope: 'global', subject: '', evidence: 'Use Resend for email, not nodemailer', basis: 'user_said', supersedes: '' },
              { kind: 'decision', content: 'The portfolio is hosted on Vercel.', scope: 'project', subject: 'portfolio', evidence: 'deploy it to Vercel', basis: 'tool_verified', supersedes: '' },
              { kind: 'decision', content: 'The portfolio launch is on 2026-03-20.', scope: 'project', subject: 'portfolio', evidence: 'The launch is next friday', basis: 'user_said', supersedes: old },
              { kind: 'decision', content: 'The contact form posts to /api/contact.', scope: 'project', subject: 'portfolio', evidence: 'Make the form post to /api/contact', basis: 'assistant_guess', supersedes: '' },
            ],
          }),
        },
      ];
    }
    if (p.includes('homelab') && p.includes('madx is my homelab server')) {
      return [
        {
          text: JSON.stringify({
            episode: 'Restarted caddy on madx.',
            items: [
              { kind: 'host', content: 'madx is an LXC on pve; hung services are restarted with systemctl, never by rebooting madx.', scope: 'global', subject: 'madx', evidence: 'When a service hangs, restart it with systemctl, never reboot madx.', basis: 'user_said', supersedes: '' },
              { kind: 'host', content: 'The caddy tunnel on madx uses CLOUDFLARE_API_TOKEN=FakeTok3nForTests1234567.', scope: 'global', subject: 'madx', evidence: 'madx is my homelab server', basis: 'user_said', supersedes: '' },
            ],
          }),
        },
      ];
    }
    return [{ text: '{"episode": "", "items": []}' }];
  }
  if (s.includes('You tidy a memory store')) return [{ text: '{"operations": [{"op": "merge", "from": "mem_nope", "into": "mem_nope2"}]}' }];
  return undefined;
}

beforeAll(async () => {
  h = buildOwnerHome();
  t = await startTestEngine({ script: [[{ text: 'ok' }]], chore, overrides: { memory: { enabled: true, autoExtract: false, autoInject: false, injectLimit: 5 }, limits: { maxRetries: 0 } } as never });
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_DIR']) saved[k] = process.env[k];
  process.env.CLAUDE_CONFIG_DIR = join(h.home, '.claude');
  process.env.CODEX_HOME = join(h.home, '.codex');
  process.env.GEMINI_DIR = join(h.home, '.gemini');
  svc = importOf(t.engine)!;
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (k === 'CLAUDE_CONFIG_DIR') continue; // the harness restores it
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await t.close();
  rmSync(h.home, { recursive: true, force: true });
});

const byTitle = (items: ExternalSessionInfo[], title: string) => items.find((x) => x.title === title)!;
const importedSessions = () => t.engine.repos.sessions.list({ archived: true } as never).filter((s: Session) => s.tags.includes('imported'));

async function run(input: Parameters<ImportService['startBatch']>[0]) {
  const b = await svc.startBatch(input);
  await svc.runBatch(b.id);
  return svc.batch(b.id);
}

describe('scan', () => {
  test('groups by project, skips automation, subagent, internal and short chats, warns about cleanup', async () => {
    const page = await svc.scan({ device: 'local', refresh: true });
    expect(page.failed).toEqual([]);
    const a = byTitle(page.items, 'Portfolio contact form');
    expect(a).toMatchObject({ source: 'claude-code', kind: 'main', humanPrompts: 4, device: 'local', cwd: '/home/kai/code/portfolio' });
    expect(a.skip).toBeUndefined();
    expect(a.estTokens).toBeGreaterThan(100);
    // the subagent transcript sits right under its parent
    const i = page.items.indexOf(a);
    expect(page.items[i + 1]).toMatchObject({ kind: 'subagent', skip: 'subagent', parentKey: a.key });
    const skip = (id: string) => page.items.find((x) => x.id === id)?.skip;
    expect(skip(OWNER.claudeC)).toBe('automation');
    expect(skip(OWNER.codexT5)).toBe('automation');
    expect(skip(OWNER.codexT4)).toBe('internal');
    expect(skip(OWNER.claudeD)).toBe('too-short');
    expect(page.items.filter((x) => !x.skip).map((x) => x.id).sort()).toEqual([OWNER.claudeA, OWNER.claudeB, OWNER.claudeB, OWNER.codexT1, OWNER.codexT2, OWNER.codexT3, OWNER.gemini].sort());
    expect(page.counts.skipped).toBe(page.items.filter((x) => x.skip).length);
    expect(page.groups!.find((g) => g.key === 'repo:github.com/kai/portfolio')).toMatchObject({ name: 'portfolio', sources: expect.arrayContaining(['codex']) });
    expect(page.unknown?.['line:mystery-telemetry']).toBe(1);
    const claude = page.retention.find((r) => r.tool === 'claude-code')!;
    expect(claude).toMatchObject({ risk: 'high', fixable: true, setting: 'cleanupPeriodDays' });
  });

  test('filters and paging', async () => {
    const codex = await svc.scan({ device: 'local', sources: ['codex'], includeSkipped: false });
    expect(codex.items.every((x) => x.source === 'codex' && !x.skip)).toBe(true);
    const p1 = await svc.scan({ device: 'local', limit: 3 });
    expect(p1.items).toHaveLength(3);
    expect(p1.next).toBe('3');
    const p2 = await svc.scan({ device: 'local', limit: 3, cursor: p1.next });
    expect(p2.items[0].key).not.toBe(p1.items[0].key);
    expect(p2.groups).toBeUndefined();
  });

  test('the retention fix writes 10 years and keeps the other keys', async () => {
    const after = await svc.fixRetention('local', 'claude-code');
    expect(after.find((r) => r.tool === 'claude-code')).toMatchObject({ risk: 'none', value: 3650 });
    const file = JSON.parse(await Bun.file(join(h.home, '.claude/settings.json')).text());
    expect(file).toMatchObject({ model: 'opus', cleanupPeriodDays: 3650, permissions: { allow: ['Bash(bun test:*)'] } });
  });
});

describe('estimate', () => {
  test('chats only costs nothing; learning counts windows, prompts and one consolidation per project', async () => {
    const chats = await svc.estimate({ device: 'local', query: {}, mode: 'chats' });
    expect(chats.tokensIn).toBe(0);
    expect(chats.skipped.automation).toBe(2);
    const learn = await svc.estimate({ device: 'local', query: {}, mode: 'chats-learn' });
    expect(learn.sessions).toBe(chats.sessions);
    expect(learn.windows).toBeGreaterThanOrEqual(learn.sessions);
    expect(learn.tokensIn).toBeGreaterThan(learn.windows * 3_000);
    expect(learn.consolidationCalls).toBeGreaterThan(0);
    expect(learn.options[0]).toMatchObject({ model: 'mock/claude-sonnet-5-5', configured: true, usable: true });
    expect(learn.model).toBe('mock/claude-sonnet-5-5');
  });
});

describe('import, re-import, update and merge', () => {
  let aKey = '';
  let aSession = '';
  let firstBatch = '';

  test('chats only: sessions are archived copies, nothing is sent to a model', async () => {
    const chores = t.chores.length;
    const b = await run({ device: 'local', query: { sources: ['claude-code', 'codex'] }, mode: 'chats' });
    firstBatch = b.id;
    expect(b.status).toBe('done');
    expect(b.failed).toBe(0);
    expect(b.imported).toBeGreaterThanOrEqual(4);
    expect(b.skipped).toBeGreaterThanOrEqual(4);
    expect(t.chores.length).toBe(chores);
    const page = await svc.scan({ device: 'local' });
    const a = byTitle(page.items, 'Portfolio contact form');
    aKey = a.key;
    aSession = a.imported!.sessionId!;
    expect(a.imported).toMatchObject({ state: 'current', learned: false, batchId: b.id });
    const s = t.engine.repos.sessions.get(aSession)!;
    expect(s).toMatchObject({ archived: true, cwd: '/home/kai/code/portfolio', device: 'local', model: 'claude-code/default', external: { 'claude-code': OWNER.claudeA } });
    expect(s.tags).toEqual(['imported', 'claude-code']);
    expect(s.createdAt).toBe(Date.parse('2026-03-14T09:00:00.000Z'));
    expect((s.meta?.import as SessionImportInfo).source).toBe('claude-code');
    const msgs = t.engine.repos.messages.list(aSession);
    // the first resumed turn does not read the whole old chat for memory
    expect(t.engine.repos.kv.get(`memory.extract.${aSession}`, -1)).toBe(msgs.length);
    // the two Claude Code sessions with one id in two folders are two Conclave sessions
    const homelab = page.items.filter((x) => x.id === OWNER.claudeB);
    expect(homelab).toHaveLength(2);
    expect(new Set(homelab.map((x) => x.imported?.sessionId)).size).toBe(2);
  });

  test('a re-run imports nothing new', async () => {
    const before = importedSessions().length;
    const b = await run({ device: 'local', query: { sources: ['claude-code', 'codex'] }, mode: 'chats' });
    expect(b.imported).toBe(0);
    expect(b.unchanged).toBeGreaterThanOrEqual(4);
    expect(importedSessions().length).toBe(before);
  });

  test('a grown source appends the rest', async () => {
    const before = t.engine.repos.messages.list(aSession).length;
    growClaudeA(h.home);
    const page = await svc.scan({ device: 'local', refresh: true });
    expect(page.items.find((x) => x.key === aKey)!.imported).toMatchObject({ state: 'behind', newThere: 2 });
    const b = await run({ device: 'local', keys: [aKey], mode: 'chats' });
    expect(b.updated).toBe(1);
    const msgs = t.engine.repos.messages.list(aSession);
    expect(msgs.length).toBe(before + 2);
    expect(msgs[msgs.length - 2].meta?.batchId).toBe(b.id);
    expect(JSON.stringify(msgs)).toContain('Plausible analytics');
    expect((t.engine.repos.sessions.get(aSession)!.meta?.import as SessionImportInfo).state).toBe('current');
  });

  test("turns Conclave ran through the same harness session are not copied twice", async () => {
    const seq = t.engine.repos.messages.nextSeq(aSession);
    const native = (role: 'user' | 'assistant', text: string, i: number): Message => ({ id: newId('msg'), sessionId: aSession, seq: seq + i, role, kind: 'normal', content: [{ type: 'text', text }], createdAt: Date.now() });
    t.engine.repos.messages.insert(native('user', 'Add a sitemap too.', 0));
    t.engine.repos.messages.insert(native('assistant', 'Added the sitemap integration.', 1));
    const p = h.path('claudeA');
    const u = (n: number) => `a${String(n).padStart(4, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const line = (o: Record<string, unknown>) => JSON.stringify({ isSidechain: false, cwd: '/home/kai/code/portfolio', sessionId: OWNER.claudeA, ...o });
    appendFileSync(
      p,
      [
        line({ type: 'user', parentUuid: u(41), uuid: u(42), timestamp: '2026-03-16T08:00:00Z', message: { role: 'user', content: 'Add a sitemap too.' } }),
        line({ type: 'assistant', parentUuid: u(42), uuid: u(43), timestamp: '2026-03-16T08:01:00Z', message: { id: 'msg_30', role: 'assistant', model: 'claude-opus-4-6', content: [{ type: 'text', text: 'Added the sitemap integration.' }], stop_reason: 'end_turn' } }),
        line({ type: 'last-prompt', leafUuid: u(42) }),
      ].join('\n') + '\n',
    );
    const at = new Date('2026-03-16T08:02:00Z');
    utimesSync(p, at, at);
    const r = await svc.syncSession(aSession);
    expect(r).toEqual({ state: 'unchanged', added: 0 });
    expect(t.engine.repos.messages.list(aSession).filter((m) => JSON.stringify(m.content).includes('Add a sitemap too.'))).toHaveLength(1);
  });

  test('both sides grown makes a fork, never an interleave', async () => {
    const seq = t.engine.repos.messages.nextSeq(aSession);
    t.engine.repos.messages.insert({ id: newId('msg'), sessionId: aSession, seq, role: 'user', kind: 'normal', content: [{ type: 'text', text: 'Only in Conclave: write the README.' }], createdAt: Date.now() });
    const p = h.path('claudeA');
    const u = (n: number) => `a${String(n).padStart(4, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const line = (o: Record<string, unknown>) => JSON.stringify({ isSidechain: false, cwd: '/home/kai/code/portfolio', sessionId: OWNER.claudeA, ...o });
    appendFileSync(p, [line({ type: 'user', parentUuid: u(43), uuid: u(44), timestamp: '2026-03-17T08:00:00Z', message: { role: 'user', content: 'Only in Claude Code: bump astro.' } }), line({ type: 'last-prompt', leafUuid: u(44) })].join('\n') + '\n');
    const at = new Date('2026-03-17T08:01:00Z');
    utimesSync(p, at, at);
    const page = await svc.scan({ device: 'local', refresh: true });
    expect(page.items.find((x) => x.key === aKey)!.imported?.state).toBe('diverged');
    const r = await svc.syncSession(aSession);
    expect(r.state).toBe('forked');
    const fork = t.engine.repos.sessions.get(r.forkedSessionId!)!;
    expect(fork.parentId).toBe(aSession);
    expect(fork.title).toBe(`Continued in Claude Code on ${t.engine.devices.list()[0].name}`);
    expect(JSON.stringify(t.engine.repos.messages.list(fork.id))).toContain('Only in Claude Code: bump astro.');
    expect(JSON.stringify(t.engine.repos.messages.list(aSession))).not.toContain('bump astro');
  });

  test('the older single import returns the session already there', async () => {
    const s = await svc.importOne('codex', OWNER.codexT1, 'local');
    const page = await svc.scan({ device: 'local' });
    expect(s.id).toBe(page.items.find((x) => x.id === OWNER.codexT1)!.imported!.sessionId!);
  });

  test('learn from imported chats: checks in code, provenance, the review queue, supersede', async () => {
    const old = await t.engine.memory.save({ content: 'The portfolio launch is on 2026-03-01.', kind: 'fact', scope: 'project', scopeKey: '/home/kai/code/portfolio' });
    const notLearned = svc.batches().notLearned;
    expect(notLearned).toBeGreaterThanOrEqual(4);
    const b = await run({ device: 'local', notLearned: true, mode: 'learn' });
    expect(b.status).toBe('done');
    expect(b.learnedSessions).toBe(notLearned);
    // made up evidence, an unknown basis, a secret in the content
    expect(b.dropped).toMatchObject({ evidence: 1, basis: 1, secret: 1 });
    expect(b.dropped['consolidation-ignored']).toBeGreaterThanOrEqual(1);
    expect(b.memoriesReview).toBe(1);
    expect(b.memoriesAdded).toBe(3);
    // the session date goes in, not today
    const prompt = learnPrompts.find((p) => p.includes('Portfolio contact form'))!;
    expect(prompt).toContain('date=\\"2026-03-14\\"');
    expect(prompt).toContain('[user] Ship it.');
    expect(prompt).not.toContain('bank pin');
    const deploy = (await t.engine.memory.search('bun run deploy repo root', { limit: 5, external: false } as never)).find((m) => m.kind === 'procedure')!;
    expect(deploy.tags).toEqual(expect.arrayContaining(['learned', 'source:claude-code', `batch:${b.id}`, 'kind:procedure']));
    expect(deploy.meta).toMatchObject({ source: 'claude-code', device: 'local', extSessionId: OWNER.claudeA, basis: 'user_said', batchId: b.id, observedAt: Date.parse('2026-03-14T09:00:00.000Z') });
    expect(deploy.scopeKey).toBe('/home/kai/code/portfolio');
    const host = (await t.engine.memory.search('madx systemctl reboot', { limit: 5, external: false } as never)).find((m) => m.content.startsWith('madx is an LXC'))!;
    expect(host.tags).toContain('host:madx');
    // superseded rows are kept, recall skips them
    expect(t.engine.memory.get(old.id)!.meta?.supersededBy).toBeDefined();
    const hits = await t.engine.memory.recall('portfolio launch date', { project: '/home/kai/code/portfolio' });
    expect(hits.map((x) => x.id)).not.toContain(old.id);
    // one session said it once: it waits for the owner
    const queue = svc.reviewQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ evidence: 'Use Resend for email, not nodemailer', basis: 'user_said', source: 'claude-code', seenCount: 1, sessionTitle: 'Portfolio contact form' });
    // a preference is a profile memory: it reaches the system prompt only once accepted
    expect(t.engine.memory.profile({}).map((x) => x.id)).not.toContain(queue[0].memory.id);
    // learned sessions are not offered again
    expect(svc.batches().notLearned).toBe(0);
    const s = t.engine.repos.sessions.get(aSession)!;
    expect((s.meta?.import as SessionImportInfo).learned).toBe(true);
    expect(t.engine.repos.kv.get(`memory.extract.${aSession}`, -1)).toBe(t.engine.repos.messages.list(aSession).at(-1)!.seq);

    // accept it and it is recalled
    expect(await svc.answerReview({ accept: [queue[0].memory.id] })).toEqual({ accepted: 1, rejected: 0 });
    expect(t.engine.memory.profile({}).map((x) => x.id)).toContain(queue[0].memory.id);
    expect(svc.reviewQueue()).toHaveLength(0);

    // undo: memories go, the supersede link is cleared, the sessions can be learned again
    const undo = await svc.undo(b.id);
    expect(undo.memoriesRemoved).toBeGreaterThanOrEqual(4);
    expect(undo.supersedesCleared).toBe(1);
    expect(t.engine.memory.get(old.id)!.meta?.supersededBy).toBeUndefined();
    expect(t.engine.memory.get(deploy.id)).toBeUndefined();
    expect(svc.batches().notLearned).toBe(notLearned);
    expect(svc.batch(b.id).status).toBe('undone');
  });

  test('a model limit parks the batch until the reset', async () => {
    limitNext = true;
    const b0 = await svc.startBatch({ device: 'local', keys: [aKey], mode: 'learn' });
    await svc.runBatch(b0.id);
    const b = svc.batch(b0.id);
    expect(b.status).toBe('waiting_reset');
    expect(b.resumeAt).toBeGreaterThan(Date.now() - 1000);
    // the job resumes where it stopped
    await svc.runBatch(b0.id);
    expect(svc.batch(b0.id).status).toBe('done');
    await svc.undo(b0.id);
  });

  test('pause, resume and cancel', async () => {
    const b = await svc.startBatch({ device: 'local', keys: [aKey], mode: 'chats' });
    expect(svc.pause(b.id).status).toBe('paused');
    await svc.runBatch(b.id);
    expect(svc.batch(b.id).items[0].state).toBe('queued');
    expect(svc.resume(b.id).status).toBe('importing');
    await svc.runBatch(b.id);
    expect(svc.batch(b.id).status).toBe('done');
    expect(() => svc.cancel(b.id)).toThrow('already done');
  });

  test('undo of the first import removes its sessions and resets the ledger', async () => {
    const r = await svc.undo(firstBatch);
    expect(r.sessionsRemoved).toBeGreaterThanOrEqual(3);
    // the portfolio session has turns Conclave ran since the import: undo keeps it whole and says so
    expect(t.engine.repos.sessions.get(aSession)).toBeDefined();
    expect(r.keptSessions?.map((x) => x.id)).toEqual([aSession]);
    const page = await svc.scan({ device: 'local' });
    expect(byTitle(page.items, 'Dark mode toggle for the portfolio').imported).toBeUndefined();
    // the fork the sync made is not part of that batch: the location now points at it
    const a = byTitle(page.items, 'Portfolio contact form');
    expect(t.engine.repos.sessions.get(a.imported!.sessionId!)!.title).toStartWith('Continued in Claude Code');
    expect(() => svc.undo(firstBatch)).toThrow();
  });
});

describe('learn memory only and uploads', () => {
  test('learn only reads the source and makes no session', async () => {
    const before = importedSessions().length;
    const page = await svc.scan({ device: 'local' });
    const homelab = page.items.find((x) => x.id === OWNER.claudeB && x.cwd === '/home/kai/code/homelab')!;
    const b = await run({ device: 'local', keys: [homelab.key], mode: 'learn' });
    expect(b.status).toBe('done');
    expect(b.learnedSessions).toBe(1);
    expect(b.memoriesAdded).toBe(1);
    expect(importedSessions().length).toBe(before);
    const m = (t.engine.memory as SqliteMemory).withTag(`batch:${b.id}`).find((x) => x.kind !== 'episode')!;
    expect(m.meta).toMatchObject({ source: 'claude-code', extSessionId: OWNER.claudeB });
    expect(m.sourceSessionId).toBeUndefined();
    // learned under that fingerprint: a second run has nothing to do
    const again = await run({ device: 'local', keys: [homelab.key], mode: 'learn' });
    expect(again.memoriesAdded).toBe(0);
  });

  test('claude.ai zip and ChatGPT json uploads import as chats, once', async () => {
    const zip = zipOf({ 'conversations.json': JSON.stringify(claudeAiExport()), 'projects.json': JSON.stringify([{ uuid: 'p-travel', name: 'Travel' }]) });
    const up = svc.upload('claude-ai', zip, 'export.zip');
    expect(up).toMatchObject({ source: 'claude-ai', items: 2 });
    expect(up.unknownContentTypes['content:voice_note']).toBe(1);
    const device = `upload:${up.uploadId}`;
    const page = await svc.scan({ device });
    expect(page.items.map((x) => x.title)).toEqual(['Lisbon trip food']);
    const b = await run({ device, query: {}, mode: 'chats', includeSkipped: true });
    expect(b.imported).toBe(1);
    const s = t.engine.repos.sessions.get((await svc.scan({ device })).items[0].imported!.sessionId!)!;
    expect(s).toMatchObject({ kind: 'chat', device: 'local', archived: true, title: 'Lisbon trip food' });

    const gpt = svc.upload('chatgpt', new TextEncoder().encode(JSON.stringify(chatGptExport())));
    const b2 = await run({ device: `upload:${gpt.uploadId}`, query: {}, mode: 'chats', includeSkipped: true });
    expect(b2.imported).toBe(1);
    // the same export again matches by fingerprint
    const again = svc.upload('chatgpt', new TextEncoder().encode(JSON.stringify(chatGptExport())));
    const b3 = await run({ device: `upload:${again.uploadId}`, query: {}, mode: 'chats', includeSkipped: true });
    expect(b3.imported).toBe(0);
    expect(b3.unchanged).toBe(1);
    expect(() => svc.upload('chatgpt', new TextEncoder().encode('{"not": "a list"}'))).toThrow();
  });
});

describe('the scan the pairing offer makes (import/offers.ts)', () => {
  test('newChats counts what an import would bring, per tool', async () => {
    const counts = await svc.newChats('local');
    const page = await svc.scan({ device: 'local' });
    expect(Object.keys(counts).every((k) => ['claude-code', 'codex', 'gemini'].includes(k))).toBe(true);
    expect(Object.values(counts).reduce((a, b) => a + (b ?? 0), 0)).toBe(page.counts.new);
  });

  test('the older single import reads the device again for a chat written since a fresh scan', async () => {
    const p = h.path('claudeD');
    const kept = readFileSync(p);
    rmSync(p);
    await svc.scan({ device: 'local', refresh: true });
    writeFileSync(p, kept);
    const s = await svc.importOne('claude-code', OWNER.claudeD, 'local');
    expect(t.engine.repos.sessions.get(s.id)).toBeDefined();
  });
});
