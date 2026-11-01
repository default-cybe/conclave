import { afterEach, describe, expect, test } from 'bun:test';
import { SqliteMemory } from '../../src/memory/store';
import type { ExternalMemory, ExternalNote } from '../../src/memory/external';
import { KvRepo } from '../../src/storage/repos';
import { fakeEmbed, msg, setup } from './helpers';

let env: ReturnType<typeof setup>;
afterEach(() => env?.cleanup());

function mk(opts: { complete?: (o: { system?: string; prompt: string }) => Promise<string>; embed?: typeof fakeEmbed; external?: ExternalMemory; mode?: 'mirror' | 'external' } = {}) {
  env = setup();
  if (opts.mode) env.config.update({ memory: { ...env.config.get().memory, external: { type: 'mcp', mcpServer: 'bm', mode: opts.mode } } });
  const calls: Array<{ system?: string; prompt: string }> = [];
  const mem = new SqliteMemory({
    db: env.db,
    bus: env.bus,
    config: env.config,
    complete: async (o) => {
      calls.push(o);
      return opts.complete ? opts.complete(o) : '{"add":[],"update":[]}';
    },
    embed: opts.embed,
    external: opts.external,
  });
  return { mem, calls };
}

describe('save and dedupe', () => {
  test('near duplicate updates the existing entry', async () => {
    const { mem } = mk();
    const a = await mem.save({ content: 'The user prefers dark mode in all editors', tags: ['ui'] });
    const b = await mem.save({ content: 'User prefers dark mode in editors', tags: ['editor'] });
    expect(b.id).toBe(a.id);
    expect(b.tags.sort()).toEqual(['editor', 'ui']);
    expect(mem.stats().total).toBe(1);
    expect(env.events.filter((e) => e === 'memory.updated').length).toBe(2);
  });

  test('different facts are kept apart, scopes do not dedupe across', async () => {
    const { mem } = mk();
    const a = await mem.save({ content: 'The Proxmox host lives at 10.0.0.5' });
    const b = await mem.save({ content: 'The user studies computer science at university' });
    const c = await mem.save({ content: 'The Proxmox host lives at 10.0.0.5', scope: 'project', scopeKey: '/code/homelab' });
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    expect(c.scope).toBe('project');
  });

  test('cosine dedupe with embeddings', async () => {
    const { mem } = mk({ embed: fakeEmbed });
    const a = await mem.save({ content: 'Deploys use make release on the homelab' });
    const b = await mem.save({ content: 'deploys use make release on homelab' });
    expect(b.id).toBe(a.id);
  });

  test('secrets are redacted on explicit save', async () => {
    const { mem } = mk();
    const e = await mem.save({ content: 'The OpenAI key is sk-abcdefghijklmnopqrstuvwxyz123456' });
    expect(e.content).not.toContain('sk-abcdef');
    expect(e.content).toContain('[redacted]');
  });

  test('update and remove keep FTS in sync', async () => {
    const { mem } = mk();
    const e = await mem.save({ content: 'The user runs Arch Linux on the desktop PC' });
    await mem.update(e.id, { content: 'The user runs NixOS on the desktop PC' });
    expect((await mem.search('nixos', { external: false }))[0]?.id).toBe(e.id);
    expect((await mem.search('arch', { external: false })).length).toBe(0);
    expect(await mem.remove(e.id)).toBe(true);
    expect((await mem.search('nixos', { external: false })).length).toBe(0);
    expect(env.events).toContain('memory.deleted');
  });
});

describe('search', () => {
  test('ranks the relevant memory first and boosts importance', async () => {
    const { mem } = mk();
    await mem.save({ content: 'The user likes short answers without preamble' });
    const px = await mem.save({ content: 'Proxmox host IP is 10.0.0.5 and runs the LXC containers', importance: 0.9 });
    await mem.save({ content: 'The user has an exam in operating systems on 2026-11-02' });
    const hits = await mem.search('what is the proxmox ip?', { external: false });
    expect(hits[0].id).toBe(px.id);
    expect(hits[0].score).toBeGreaterThan(0.5);
  });

  test('scope filter keeps global plus the matching project', async () => {
    const { mem } = mk();
    await mem.save({ content: 'Docker compose files live in /srv/stacks', scope: 'project', scopeKey: '/a' });
    await mem.save({ content: 'Docker images are built nightly', scope: 'project', scopeKey: '/b' });
    await mem.save({ content: 'Docker is installed on every box' });
    const hits = await mem.search('docker', { scope: 'project', scopeKey: '/a', external: false });
    expect(hits.map((h) => h.scopeKey ?? 'global').sort()).toEqual(['/a', 'global']);
    expect(hits[0].scopeKey).toBe('/a');
  });

  test('hybrid search finds a semantic match without shared words when vectors exist', async () => {
    const { mem } = mk({ embed: fakeEmbed });
    const e = await mem.save({ content: 'grafana dashboards on port 3000' });
    const hits = await mem.search('grafana', { external: false });
    expect(hits[0].id).toBe(e.id);
  });

  test('external hits are merged and failures are ignored', async () => {
    const ext: ExternalMemory = {
      name: 'bm',
      search: async () => [{ id: 'infra/proxmox', title: 'Proxmox', content: 'Proxmox cluster notes with node names', score: 0.8 }],
      write: async () => {},
    };
    const { mem } = mk({ external: ext });
    await mem.save({ content: 'Proxmox backups run at 02:00' });
    const hits = await mem.search('proxmox');
    expect(hits.some((h) => h.id === 'ext:bm:infra/proxmox')).toBe(true);

    const broken: ExternalMemory = { name: 'bm', search: async () => Promise.reject(new Error('down')), write: async () => {} };
    const m2 = new SqliteMemory({ db: env.db, bus: env.bus, config: env.config, complete: async () => '', external: broken });
    expect((await m2.search('proxmox')).length).toBe(1);
  });
});

describe('profile and recall', () => {
  test('profile returns global + project + agent entries within budget', async () => {
    const { mem } = mk();
    await mem.save({ content: 'The user is a CS student and runs a homelab', kind: 'profile' });
    await mem.save({ content: 'In this repo use bun, never npm', kind: 'profile', scope: 'project', scopeKey: '/repo' });
    await mem.save({ content: 'Other repo uses pnpm', kind: 'profile', scope: 'project', scopeKey: '/other' });
    await mem.save({ content: 'The reviewer agent is strict about tests', kind: 'profile', scope: 'agent', scopeKey: 'reviewer' });
    await mem.save({ content: 'x '.repeat(4000), kind: 'profile', importance: 0.1 });
    const p = mem.profile({ project: '/repo', agent: 'reviewer' });
    expect(p.map((e) => e.content)).toEqual(
      expect.arrayContaining(['The user is a CS student and runs a homelab', 'In this repo use bun, never npm', 'The reviewer agent is strict about tests']),
    );
    expect(p.some((e) => e.content.includes('pnpm'))).toBe(false);
    expect(p.some((e) => e.content.startsWith('x x'))).toBe(false);
  });

  test('recall skips profile, drops junk and marks usage', async () => {
    const { mem } = mk();
    await mem.save({ content: 'The user prefers answers in British English', kind: 'profile' });
    const f = await mem.save({ content: 'The ntfy server runs at ntfy.home.lan on the infra LXC' });
    await mem.save({ content: 'The user enjoys climbing on weekends' });
    const hits = await mem.recall('how do I send a test message to my ntfy server?', {});
    expect(hits.map((h) => h.id)).toEqual([f.id]);
    expect(mem.get(f.id)?.useCount).toBe(1);
    expect(mem.get(f.id)?.lastUsedAt).toBeDefined();
    expect(await mem.recall('tell me a joke about cats', {})).toEqual([]);
  });
});

describe('extract', () => {
  test('parses JSON, drops secrets, tracks offset', async () => {
    let existingId = '';
    const { mem, calls } = mk({
      complete: async (o) => {
        if (o.prompt.includes('Helix')) return '{"add":[],"update":[]}';
        expect(o.prompt).toContain('<transcript>');
        expect(o.prompt).toContain(existingId);
        return '```json\n' +
          JSON.stringify({
            add: [
              { content: 'The user moved the ntfy server to the infra LXC', kind: 'fact', tags: ['ntfy', 'Infra'], scope: 'global' },
              { content: 'The user API token is ghp_abcdefghijklmnopqrstuvwxyz0123456789', kind: 'fact', scope: 'global' },
              { content: 'This repo deploys with make release', kind: 'procedure', scope: 'project' },
            ],
            update: [
              { id: existingId, content: 'The user exam in operating systems moved to 2026-11-09' },
              { id: 'mem_unknown', content: 'should be ignored because the id is unknown' },
            ],
          }) +
          '\n```';
      },
    });
    existingId = (await mem.save({ content: 'The user has an exam in operating systems on 2026-11-02' })).id;
    const messages = [
      msg('user', 'I moved ntfy to the infra LXC. Also my exam in operating systems moved to the 9th.', 's1', 1),
      msg('assistant', 'Noted, I will remember the new exam date.', 's1', 2),
    ];
    const out = await mem.extract('s1', messages, { project: '/repo' });
    expect(out.length).toBe(3);
    expect(mem.get(existingId)?.content).toContain('2026-11-09');
    const all = mem.list();
    expect(all.some((e) => e.content.includes('ghp_'))).toBe(false);
    const proc = all.find((e) => e.kind === 'procedure');
    expect(proc?.scope).toBe('project');
    expect(proc?.scopeKey).toBe('/repo');
    expect(all.find((e) => e.content.includes('ntfy'))?.tags).toEqual(['ntfy', 'infra']);
    expect(new KvRepo(env.db).get('memory.extract.s1', 0)).toBe(2);

    // same messages again: nothing new, no model call
    const n = calls.length;
    expect(await mem.extract('s1', messages, {})).toEqual([]);
    expect(calls.length).toBe(n);

    // only the new part is sent next time
    await mem.extract('s1', [...messages, msg('user', 'I switched my editor to Helix for good.', 's1', 3)], {});
    expect(calls.at(-1)?.prompt).toContain('Helix');
    expect(calls.at(-1)?.prompt).not.toContain('moved ntfy');
  });

  test('non JSON replies are ignored', async () => {
    const { mem } = mk({ complete: async () => 'Sure! Here are the memories: none.' });
    const out = await mem.extract('s2', [msg('user', 'I like tea a lot more than coffee these days', 's2', 1)], {});
    expect(out).toEqual([]);
    expect(mem.stats().total).toBe(0);
  });
});

describe('episodes', () => {
  test('one episode per session, written to the external server in mirror mode', async () => {
    const notes: ExternalNote[] = [];
    const ext: ExternalMemory = { name: 'bm', search: async () => [], write: async (n) => void notes.push(n) };
    let n = 0;
    const { mem } = mk({ external: ext, mode: 'mirror', complete: async () => `Summary:\n- User asked to fix the backup job (${++n})\n- Fixed cron path\n- Outcome: backups run again` });
    const messages = [msg('user', 'fix the backup job on pve', 'e1', 1), msg('assistant', 'Done, the cron path was wrong.', 'e1', 2)];
    const a = await mem.summarizeEpisode('e1', messages, { project: '/home/me/homelab', agent: 'ops' });
    const b = await mem.summarizeEpisode('e1', messages, { project: '/home/me/homelab', agent: 'ops' });
    expect(a?.kind).toBe('episode');
    expect(b?.id).toBe(a!.id);
    expect(b?.content.split('\n').length).toBe(3);
    expect(b?.content).toContain('(2)');
    await Bun.sleep(5);
    expect(notes.length).toBe(2);
    expect(notes[0].folder).toBe('conclave/sessions');
    expect(notes[0].content).toContain('[[homelab]]');
    expect(notes[0].tags).toContain('homelab');
  });

  test('the episode note is titled by the first prompt, with secrets redacted', async () => {
    const notes: ExternalNote[] = [];
    const ext: ExternalMemory = { name: 'bm', search: async () => [], write: async (n) => void notes.push(n) };
    const { mem } = mk({ external: ext, mode: 'mirror', complete: async () => 'Pushed the fix\nCI is green' });
    const token = 'ghp_' + 'a1B2c3D4e5'.repeat(4);
    const messages = [msg('user', `push the fix with ${token}`, 'e3', 1), msg('assistant', 'Pushed.', 'e3', 2), msg('user', 'now the long part '.repeat(40), 'e3', 3), msg('assistant', 'Done.', 'e3', 4)];
    await mem.summarizeEpisode('e3', messages, {});
    await Bun.sleep(5);
    expect(notes[0].title).toContain('push the fix with');
    expect(JSON.stringify(notes[0])).not.toContain(token);
  });

  test('external mode keeps episodes off the local store but profile stays local', async () => {
    const notes: ExternalNote[] = [];
    const ext: ExternalMemory = { name: 'bm', search: async () => [], write: async (n) => void notes.push(n) };
    const { mem } = mk({ external: ext, mode: 'external', complete: async () => 'Line one\nLine two\nLine three' });
    const ep = await mem.summarizeEpisode('e2', [msg('user', 'hello there friend', 'e2', 1), msg('assistant', 'hi, what is up', 'e2', 2)], {});
    expect(ep?.id.startsWith('ext:')).toBe(true);
    const fact = await mem.save({ content: 'The user owns a Mac mini' });
    expect(fact.id.startsWith('ext:')).toBe(true);
    const prof = await mem.save({ content: 'The user is in Europe/Berlin time', kind: 'profile' });
    expect(prof.id.startsWith('mem_')).toBe(true);
    expect(mem.stats().total).toBe(1);
    expect(notes.length).toBe(2);
  });
});
