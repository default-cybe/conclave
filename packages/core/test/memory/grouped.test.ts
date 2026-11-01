/**
 * Grouped notes in Basic Memory (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 1.9):
 * one note per project and host, rebuilt from local rows, so updates and
 * deletes reach the store and a 1,000 item import makes a bounded number
 * of writes. The Basic Memory server is faked at the MCP tool level.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { MemoryConnections } from '../../src/memory/connections/manager';
import { MemoryConnectionService } from '../../src/memory/connections/service';
import { noteKeyOf, renderGroupedNote } from '../../src/memory/connections/grouped';
import type { MemoryConnectionConfig } from '../../src/memory/connections/types';
import { SqliteMemory } from '../../src/memory/store';
import type { MemoryEntry } from '../../src/types';
import { setup } from './helpers';

let env: ReturnType<typeof setup>;
afterEach(() => env?.cleanup());

interface Call {
  tool: string;
  args: Record<string, unknown>;
}

function mk(connections: MemoryConnectionConfig[], opts: { noDelete?: boolean } = {}) {
  env = setup({ mcpServers: { 'basic-memory': { command: 'uvx' } } } as never);
  env.config.update({ memory: { ...env.config.get().memory, enabled: true, connections } });
  const calls: Call[] = [];
  const conns = new MemoryConnections({
    config: env.config,
    callTool: async (_server, tool, args) => {
      if (tool === 'delete_note' && opts.noDelete) throw new Error('unknown tool delete_note');
      calls.push({ tool, args });
      if (tool === 'search_notes') return { content: '{"results": []}' };
      return { content: 'ok' };
    },
  });
  const memory = new SqliteMemory({ db: env.db, bus: env.bus, config: env.config, complete: async () => '{"add":[],"update":[]}', external: conns });
  const service = new MemoryConnectionService({ config: env.config, connections: conns, memory, db: env.db, bus: env.bus });
  const notes = () => calls.filter((c) => c.tool === 'write_note');
  return { memory, service, calls, notes, conns };
}

const BM = (id: string, layout?: 'grouped' | 'per-fact'): MemoryConnectionConfig => ({ id, type: 'basic-memory', mode: 'mirror', options: { server: 'basic-memory', ...(layout ? { layout } : {}) } });

const learned = (memory: SqliteMemory, content: string, extra: { scopeKey?: string; tags?: string[]; batch?: string } = {}) =>
  memory.saveLearned({
    content,
    kind: 'fact',
    scope: extra.scopeKey ? 'project' : 'global',
    scopeKey: extra.scopeKey,
    tags: ['learned', 'source:claude-code', ...(extra.tags ?? [])],
    meta: { source: 'claude-code', device: 'local', extSessionId: 's1', observedAt: Date.parse('2026-03-14T09:00:00Z'), batchId: extra.batch ?? 'imp_1', basis: 'user_said' },
  });

describe('grouped notes', () => {
  test('note keys and markdown', () => {
    const e = (over: Partial<MemoryEntry>): MemoryEntry => ({ id: 'm', scope: 'global', kind: 'fact', content: 'x', tags: [], importance: 0.5, createdAt: 0, updatedAt: 0, useCount: 0, ...over });
    expect(noteKeyOf(e({ kind: 'profile' }))).toBe('profile');
    expect(noteKeyOf(e({ kind: 'procedure' }))).toBe('procedures');
    expect(noteKeyOf(e({ scope: 'project', scopeKey: '/home/kai/code/portfolio' }))).toBe('projects/portfolio');
    expect(noteKeyOf(e({ tags: ['host:madx'] }))).toBe('hosts/madx');
    expect(noteKeyOf(e({ tags: ['kind:path', 'host:madx'] }))).toBe('paths');
    expect(noteKeyOf(e({ kind: 'episode', createdAt: Date.parse('2026-03-14T00:00:00Z') }))).toBe('sessions/2026-03');
    expect(noteKeyOf(e({}))).toBe('notes');
    expect(noteKeyOf(e({ tags: ['imported'] }))).toBeUndefined();
    expect(noteKeyOf(e({ meta: { review: 'pending' } }))).toBeUndefined();
    expect(noteKeyOf(e({ meta: { supersededBy: 'm2' } }))).toBeUndefined();
    const md = renderGroupedNote('projects/portfolio', [e({ content: 'The user deploys with bun run deploy.', tags: ['host:madx'], meta: { source: 'codex', observedAt: Date.parse('2026-03-14T00:00:00Z'), seenCount: 3, learnedKind: 'procedure' } })]);
    expect(md).toMatchObject({ folder: 'conclave/projects', title: 'portfolio', grouped: true });
    expect(md.content).toContain('- [procedure] The user deploys with bun run deploy. (2026-03-14, codex, seen 3 times)');
    expect(md.content).toContain('- relates_to [[madx]]');
  });

  test('one note per project and host; an update and a delete rewrite it; no per-fact notes', async () => {
    const { memory, service, notes } = mk([BM('bm', 'grouped')]);
    const a = await learned(memory, 'The portfolio deploys with bun run deploy from the repo root.', { scopeKey: '/home/kai/code/portfolio' });
    await learned(memory, 'The portfolio contact form posts to /api/contact.', { scopeKey: '/home/kai/code/portfolio' });
    await learned(memory, 'madx restarts hung services with systemctl, never a reboot.', { tags: ['host:madx'] });
    await memory.save({ content: 'The portfolio uses Astro 5.', kind: 'fact', scope: 'project', scopeKey: '/home/kai/code/portfolio' });
    await service.grouped.flush();
    const titles = notes().map((n) => `${n.args.folder}/${n.args.title}`);
    expect(titles.sort()).toEqual(['conclave/hosts/madx', 'conclave/projects/portfolio']);
    const project = notes().find((n) => n.args.title === 'portfolio')!;
    expect(String(project.args.content)).toContain('The portfolio uses Astro 5.');
    expect(String(project.args.content)).toContain('The portfolio contact form posts to /api/contact.');

    notes().length = 0;
    const before = notes().length;
    await memory.update(a.entry.id, { content: 'The portfolio deploys with bun run deploy:prod from the repo root.' });
    await service.grouped.flush();
    const rewritten = notes().slice(before);
    expect(rewritten.map((n) => n.args.title)).toEqual(['portfolio']);
    expect(String(rewritten[0].args.content)).toContain('bun run deploy:prod');

    await memory.remove(a.entry.id);
    await service.grouped.flush();
    const last = notes().filter((n) => n.args.title === 'portfolio').at(-1)!;
    expect(String(last.args.content)).not.toContain('deploy:prod');
    expect(String(last.args.content)).toContain('Astro 5');
  });

  test('1,000 learned items make a bounded number of writes', async () => {
    const { memory, service, notes } = mk([BM('bm', 'grouped')]);
    for (let i = 0; i < 1000; i++) await learned(memory, `Service ${i} on host ${['madx', 'pve', 'nas', 'arch'][i % 4]}${i} listens on port ${8000 + i}.`, { tags: [`host:${['madx', 'pve', 'nas', 'arch'][i % 4]}`] });
    await service.grouped.flush();
    // four host notes, written a few times at most (changes coalesce per note)
    expect(new Set(notes().map((n) => n.args.title))).toEqual(new Set(['madx', 'pve', 'nas', 'arch']));
    expect(notes().length).toBeLessThanOrEqual(12);
  });

  test('a per-fact connection keeps one note per fact; grouping it writes the groups and deletes only the notes Conclave wrote', async () => {
    const { memory, service, calls, notes } = mk([BM('bm', 'per-fact')]);
    await memory.save({ content: 'The user runs Proxmox on a host called pve.', kind: 'fact' });
    await memory.save({ content: 'The homelab repo keeps scripts in scripts/.', kind: 'fact', scope: 'project', scopeKey: '/home/kai/code/homelab' });
    await Bun.sleep(20);
    expect(notes().every((n) => n.args.folder === 'conclave/memories')).toBe(true);
    expect(notes()).toHaveLength(2);
    await service.grouped.flush();
    expect(notes()).toHaveLength(2);

    const r = await service.groupNotes('bm', { deletePerFact: true });
    expect(r).toMatchObject({ notes: 2, perFact: 2, deleted: 2, canDelete: true, errors: [] });
    expect(calls.filter((c) => c.tool === 'delete_note').map((c) => String(c.args.identifier))).toEqual(expect.arrayContaining([expect.stringMatching(/^conclave\/memories\//)]));
    expect(service.getConnection('bm').options.layout).toBe('grouped');
    // from now on a new fact rewrites its group instead of adding a note
    const n = notes().length;
    await memory.save({ content: 'The homelab repo uses bash, not Python.', kind: 'fact', scope: 'project', scopeKey: '/home/kai/code/homelab' });
    await service.grouped.flush();
    expect(notes().slice(n).map((x) => `${x.args.folder}/${x.args.title}`)).toEqual(['conclave/projects/homelab']);
  });

  test('a server without delete_note keeps the old notes and says so', async () => {
    const { memory, service } = mk([BM('bm')], { noDelete: true });
    await memory.save({ content: 'The user runs Proxmox on a host called pve.', kind: 'fact' });
    const r = await service.groupNotes('bm', { deletePerFact: true });
    expect(r.deleted).toBe(0);
    expect(r.canDelete).toBe(false);
  });

  test('new Basic Memory connections are grouped; existing ones keep per-fact', () => {
    const { service } = mk([BM('old')]);
    expect(service.getConnection('old').options.layout).toBeUndefined();
    const c = service.addConnection({ type: 'basic-memory', name: 'Notes', options: { server: 'basic-memory' } } as never);
    expect(c.options.layout).toBe('grouped');
    expect(() => service.addConnection({ type: 'basic-memory', name: 'Bad', options: { server: 'basic-memory', layout: 'tree' } } as never)).toThrow('layout');
  });
});
