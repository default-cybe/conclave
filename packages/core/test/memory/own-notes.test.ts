/**
 * Already in your notes (SqliteMemory.inOwnNotes, docs/MEMORY.md): a learned
 * fact the owner's own Basic Memory notes already state is not saved again,
 * after a session goes idle or in the import's learning job, and is counted.
 * Notes in the folder Conclave writes never count, a slow Basic Memory is
 * skipped, and nothing writes or deletes a note of the owner's. The Basic
 * Memory here is the stdio fake (fixtures/fake-mcp-server.ts).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEMORY_TUNING, SqliteMemory } from '../../src/memory/store';
import { MemoryConnections } from '../../src/memory/connections/manager';
import { BasicMemoryAdapter } from '../../src/memory/connections/basic-memory';
import { resolveConnection } from '../../src/memory/connections/registry';
import { noteInFolder } from '../../src/memory/external';
import { landItems, type LearnContext, type LearnedItem } from '../../src/import/learn';
import type { ExtractReport } from '../../src/memory/types';
import { msg, setup } from './helpers';

const FIXTURE = join(import.meta.dir, 'fixtures', 'fake-mcp-server.ts');

const NOTES = [
  { title: 'madx', folder: 'infra', content: '- [fact] runs Debian 12 with Docker\n- [fact] Backups go to PBS on pve every night', tags: [] },
  { title: 'Portfolio', folder: 'projects', content: 'The portfolio deploys with bun run deploy from the repo root.', tags: [] },
  { title: 'bun', folder: 'tools', content: 'The user prefers bun over npm.', tags: [] },
  // Conclave's own grouped note: a fact here is Conclave's, not the owner's
  { title: 'notes', folder: 'conclave', content: '# Notes\n\n## Observations\n\n- [decision] The portfolio is hosted on Vercel. (2026-01-02, claude-code)', tags: ['conclave'] },
];

let env: ReturnType<typeof setup> | undefined;
let connections: MemoryConnections | undefined;
afterEach(async () => {
  await connections?.close();
  connections = undefined;
  env?.cleanup();
  env = undefined;
});

function mk(opts: { notes?: unknown[]; embed?: (t: string[]) => Promise<number[][]>; complete?: () => Promise<string>; env?: Record<string, string>; connection?: Record<string, unknown> } = {}) {
  env = setup();
  const log = join(env.config.paths.home, 'bm-calls.jsonl');
  env.config.update({
    memory: {
      ...env.config.get().memory,
      connections: [{ id: 'notes', type: 'basic-memory', mode: 'mirror', ...opts.connection, options: { command: process.execPath, args: [FIXTURE, 'basic-memory'], env: { FAKE_NOTES: JSON.stringify(opts.notes ?? NOTES), FAKE_LOG: log, ...opts.env } } }],
    },
  });
  connections = new MemoryConnections({ config: env.config });
  const mem = new SqliteMemory({ db: env.db, bus: env.bus, config: env.config, complete: opts.complete ?? (async () => '{"add":[],"update":[]}'), embed: opts.embed, external: connections });
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { tool: string; args: Record<string, any> })
      : [];
  return { mem, calls };
}

const ctx: LearnContext = { sessionDate: Date.parse('2026-09-01'), today: Date.parse('2026-10-21'), device: 'local', deviceName: 'arch-desktop', source: 'claude-code', sourceName: 'Claude Code', extSessionId: 'cc-1', batchId: 'imp_test', cwd: '/home/kai/code/portfolio' };
const item = (kind: LearnedItem['kind'], content: string): LearnedItem => ({ kind, content, scope: 'global', subject: '', evidence: content, basis: 'user_said' });

/** Nothing of the owner's is written or deleted: the only writes go to Conclave's own folder. */
function ownerNotesUntouched(calls: Array<{ tool: string; args: Record<string, any> }>) {
  expect(calls.some((c) => c.tool === 'delete_note')).toBe(false);
  for (const c of calls.filter((x) => x.tool === 'write_note')) expect(String(c.args.directory ?? c.args.folder)).toMatch(/^conclave(\/|$)/);
}

describe('already in your notes', () => {
  test('the learning job skips facts the owner wrote down, and counts them', async () => {
    const { mem, calls } = mk();
    const landed = await landItems(
      mem,
      [
        item('host', 'madx runs Debian 12 with Docker.'),
        // the same words about another host is another fact
        item('host', 'pve runs Debian 12 with Docker.'),
        item('procedure', 'The portfolio deploys with bun run deploy from the repo root.'),
        // only Conclave's own note has it
        item('decision', 'The portfolio is hosted on Vercel.'),
        // a preference rides in every system prompt, so it is never checked
        item('preference', 'The user prefers bun over npm.'),
      ],
      ctx,
      [],
    );
    expect(landed).toMatchObject({ added: 2, merged: 0, review: 1, inNotes: 2 });
    const kept = mem.list().map((m) => m.content).sort();
    expect(kept).toEqual(['The portfolio is hosted on Vercel.', 'The user prefers bun over npm.', 'pve runs Debian 12 with Docker.']);

    // one small search per checked fact, nothing for the preference, and nothing written or deleted
    const searches = calls().filter((c) => c.tool === 'search_notes');
    expect(searches).toHaveLength(4);
    expect(searches.every((s) => s.args.page_size === MEMORY_TUNING.notesLimit * 2)).toBe(true);
    ownerNotesUntouched(calls());
  }, 30_000);

  test('extraction after a session goes idle does the same, and says how many', async () => {
    const reply = JSON.stringify({
      add: [
        { content: 'madx runs Debian 12 with Docker', kind: 'fact', scope: 'global' },
        { content: 'The portfolio is hosted on Vercel', kind: 'fact', scope: 'global' },
        { content: 'The user prefers bun over npm', kind: 'profile', scope: 'global' },
      ],
      update: [],
    });
    const { mem, calls } = mk({ complete: async () => reply });
    const report: ExtractReport = { inNotes: 0 };
    const out = await mem.extract('s1', [msg('user', 'madx runs Debian 12 with Docker, and the portfolio is on Vercel. I like bun.', 's1', 1), msg('assistant', 'Noted.', 's1', 2)], { report });
    expect(report.inNotes).toBe(1);
    expect(out.map((e) => e.content).sort()).toEqual(['The portfolio is hosted on Vercel', 'The user prefers bun over npm']);
    expect(mem.list().some((m) => m.content.includes('Debian'))).toBe(false);
    // mirror mode still writes the saved fact, into Conclave's own folder only
    for (let i = 0; i < 50 && !calls().some((c) => c.tool === 'write_note'); i++) await Bun.sleep(100);
    expect(calls().filter((c) => c.tool === 'write_note')).toHaveLength(1);
    expect(calls().filter((c) => c.tool === 'search_notes')).toHaveLength(2);
    ownerNotesUntouched(calls());
  }, 30_000);

  test('with embeddings, a line that says it in more words counts too', async () => {
    const notes = [{ title: 'madx', folder: 'infra', content: 'madx is the small box in the closet that runs Debian 12 for the media stack', tags: [] }];
    // a tiny embedding: every text about Debian 12 points the same way, everything else its own way
    const embed = async (texts: string[]) =>
      texts.map((t, i) => {
        const v = new Array(texts.length + 1).fill(0);
        v[/debian 12/i.test(t) ? 0 : i + 1] = 1;
        return v;
      });
    const words = mk({ notes });
    expect(await words.mem.inOwnNotes(['madx runs Debian 12', 'pve runs Debian 12'])).toEqual([false, false]);
    await connections!.close();
    env!.cleanup();
    const vectors = mk({ notes, embed });
    // the cosine is above 0.92 for both, but pve is not in the note
    expect(await vectors.mem.inOwnNotes(['madx runs Debian 12', 'pve runs Debian 12'])).toEqual([true, false]);
  }, 30_000);

  test('a Basic Memory that does not answer in time is skipped: the facts are saved as before', async () => {
    const { mem, calls } = mk({ env: { FAKE_DELAY_MS: '1500' } });
    // the process is up before the clock starts
    await connections!.search('warm up', 1);
    const timeout = MEMORY_TUNING.notesTimeoutMs;
    MEMORY_TUNING.notesTimeoutMs = 300;
    try {
      const before = calls().length;
      const t0 = performance.now();
      const facts = ['madx runs Debian 12 with Docker.', 'a', 'b', 'c', 'd', 'e'].map((f, i) => (f.length > 1 ? f : `fact number ${i} about the homelab`));
      expect(await mem.inOwnNotes(facts)).toEqual(facts.map(() => false));
      expect(performance.now() - t0).toBeLessThan(1200);
      // the first round timed out, so the rest were not asked
      expect(calls().length - before).toBe(MEMORY_TUNING.notesConcurrency);
      // and the next chat of a long import does not wait on it again
      const t1 = performance.now();
      const landed = await landItems(mem, [item('host', 'madx runs Debian 12 with Docker.')], ctx, []);
      expect(landed).toMatchObject({ added: 1, inNotes: 0 });
      expect(performance.now() - t1).toBeLessThan(250);
      expect(calls().length - before).toBe(MEMORY_TUNING.notesConcurrency);
    } finally {
      MEMORY_TUNING.notesTimeoutMs = timeout;
    }
  }, 30_000);

  test('only connections searched on each turn are asked, and a store with no notes of the owner asks nothing', async () => {
    const off = mk({ connection: { search: false } });
    expect(await off.mem.inOwnNotes(['madx runs Debian 12 with Docker.'])).toEqual([false]);
    expect(off.calls()).toEqual([]);
    await connections!.close();
    env!.cleanup();
    env = setup();
    const none = new SqliteMemory({ db: env.db, bus: env.bus, config: env.config, complete: async () => '' });
    expect(await none.inOwnNotes(['madx runs Debian 12 with Docker.'])).toEqual([false]);
  }, 30_000);

  test("the adapter leaves out the folder Conclave writes, whatever it is called", async () => {
    env = setup();
    const notes = [
      { title: 'madx', folder: 'infra', content: 'madx runs Debian 12', tags: [] },
      { title: 'notes', folder: 'ai', content: '- [fact] madx runs Debian 12 (2026-01-02, conclave)', tags: [] },
      { title: 'old', folder: 'conclave', content: 'madx runs Debian 12, from before', tags: [] },
    ];
    const a = new BasicMemoryAdapter(resolveConnection({ id: 'bm', type: 'basic-memory', options: { command: process.execPath, args: [FIXTURE, 'basic-memory'], env: { FAKE_NOTES: JSON.stringify(notes) }, folder: 'ai' } }), { config: env.config });
    try {
      expect((await a.searchOwnNotes('madx debian', 3)).map((h) => h.id).sort()).toEqual(['conclave/old', 'infra/madx']);
    } finally {
      await a.close();
    }
    // a permalink can start with the project's name
    expect(noteInFolder({ id: 'main/conclave/notes' }, ['conclave'])).toBe(true);
    expect(noteInFolder({ id: 'conclave-old/notes' }, ['conclave'])).toBe(false);
    expect(noteInFolder({ id: 'x', path: 'Conclave/hosts/madx.md' }, ['conclave/'])).toBe(true);
  }, 30_000);
});
