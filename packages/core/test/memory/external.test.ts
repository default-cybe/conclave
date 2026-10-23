import { afterAll, describe, expect, test } from 'bun:test';
import { BasicMemoryMcp, HttpMemory, episodeNote, parseBasicMemorySearch, unwrapToolResult } from '../../src/memory/external';
import { containsSecret, redactSecrets } from '../../src/memory/secrets';
import { parseExtraction } from '../../src/memory/extract';

describe('secret filter', () => {
  const secrets = [
    'my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
    'token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',
    'AKIAABCDEFGHIJKLMNOP',
    'password: hunter2',
    'the wifi password is Tr0ub4dor',
    'postgres://admin:s3cret@db.lan/app',
    'Authorization: Bearer abcdefghijklmnop1234',
    'bot 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawq',
    'api_key=abc12345xyz',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  ];
  for (const s of secrets) test(`detects: ${s.slice(0, 24)}`, () => expect(containsSecret(s)).toBe(true));

  const safe = [
    'The user prefers dark mode in editors',
    'The Proxmox host is at 10.0.0.5',
    'The user keeps passwords in Bitwarden',
    'Commit 3f2a1b4c5d6e7f8091a2b3c4d5e6f708192a3b4c fixed the build',
    'Notes live in /home/user/Documents/BasicMemory/projects/infra',
    'The user stores API tokens in the secrets store',
  ];
  for (const s of safe) test(`allows: ${s.slice(0, 24)}`, () => expect(containsSecret(s)).toBe(false));

  test('redacts in place', () => {
    expect(redactSecrets('use sk-abcdefghijklmnopqrstuvwx1234 here')).toBe('use [redacted] here');
  });
});

describe('parseExtraction', () => {
  test('tolerates chatter, fixes kinds and scopes, limits updates to known ids', () => {
    const r = parseExtraction(
      'Here you go:\n{"add":[{"content":"The user runs Basic Memory with an infra project","kind":"episode","scope":"weird","tags":["#BM","Infra Stuff"]},{"content":"short"}],"update":[{"id":"a","content":"The user now uses ntfy on port 8080"},{"id":"zzz","content":"Should be skipped entirely"}]} thanks',
      new Set(['a']),
    );
    expect(r?.add).toEqual([{ content: 'The user runs Basic Memory with an infra project', kind: 'fact', scope: 'global', tags: ['bm', 'infra-stuff'] }]);
    expect(r?.update).toEqual([{ id: 'a', content: 'The user now uses ntfy on port 8080' }]);
    expect(parseExtraction('no json here')).toBeUndefined();
  });
});

describe('Basic Memory parsing', () => {
  test('JSON results from search_notes', () => {
    const hits = parseBasicMemorySearch(
      { results: [{ title: 'Proxmox', permalink: 'infra/proxmox', content: 'Cluster of 3 nodes', score: 0.71 }], current_page: 1 },
      '',
    );
    expect(hits).toEqual([{ id: 'infra/proxmox', title: 'Proxmox', content: 'Cluster of 3 nodes', score: 0.71, url: 'memory://infra/proxmox' }]);
  });

  test('markdown text results', () => {
    const text = `# Search Results\n\n### Proxmox\n- permalink: infra/proxmox\n- score: 0.5123\n- match: three nodes in the rack\n\n### Ntfy\n- permalink: infra/ntfy\n- score: 0.3\n`;
    const hits = parseBasicMemorySearch(undefined, text);
    expect(hits.map((h) => h.id)).toEqual(['infra/proxmox', 'infra/ntfy']);
    expect(hits[0].content).toBe('three nodes in the rack');
    expect(hits[0].score).toBeCloseTo(0.5123);
    expect(parseBasicMemorySearch(undefined, 'No results found for query "x"')).toEqual([]);
  });

  test('unwrap MCP CallToolResult shapes', () => {
    expect(unwrapToolResult({ content: [{ type: 'text', text: '{"results":[]}' }] }).data).toEqual({ results: [] });
    expect(unwrapToolResult({ content: [], structuredContent: { result: [1] } }).data).toEqual([1]);
    expect(unwrapToolResult({ content: [{ type: 'text', text: 'boom' }], isError: true }).isError).toBe(true);
  });

  test('client retries without output_format and with overwrite', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const bm = new BasicMemoryMcp({
      server: 'basic-memory',
      project: 'infra',
      callTool: async (_server, tool, args) => {
        calls.push([tool, args]);
        if (tool === 'search_notes' && 'output_format' in args) throw new Error('Unexpected keyword argument output_format');
        if (tool === 'search_notes') return { content: [{ type: 'text', text: '### LXC list\n- permalink: infra/lxc\n- match: ct 101 runs ntfy' }] };
        if (tool === 'write_note' && !args.overwrite) return { isError: true, content: [{ type: 'text', text: 'Note already exists, pass overwrite=True' }] };
        return { content: [{ type: 'text', text: '# Updated note' }] };
      },
    });
    const hits = await bm.search('ntfy', 5);
    expect(hits[0].id).toBe('infra/lxc');
    await bm.search('again', 5);
    expect(calls.filter(([t, a]) => t === 'search_notes' && 'output_format' in a).length).toBe(1);
    expect(calls[1][1]).toEqual({ query: 'ntfy', page_size: 5, project: 'infra' });

    await bm.write({ title: 'T', content: 'C', tags: ['a'] });
    const writes = calls.filter(([t]) => t === 'write_note');
    expect(writes.length).toBe(2);
    expect(writes[1][1]).toMatchObject({ title: 'T', folder: 'conclave', tags: ['a'], overwrite: true, project: 'infra' });
  });

  test('episode note has observations and relations', () => {
    const n = episodeNote({ sessionId: 'ses_abc123456', summary: 'Fixed backups\nCron path was wrong', project: '/home/me/homelab', agent: 'ops', date: new Date('2026-10-16T08:00:00Z') });
    expect(n.folder).toBe('conclave/sessions');
    expect(n.title).toBe('2026-10-16 Fixed backups (456)'.replace('456', '123456'));
    expect(n.content).toContain('- [episode] Fixed backups');
    expect(n.content).toContain('- part_of [[homelab]]');
    expect(n.content).toContain('Date: 2026-10-16');
  });
});

describe('HttpMemory', () => {
  const seen: Array<{ path: string; body: any; auth: string | null }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json();
      const path = new URL(req.url).pathname;
      seen.push({ path, body, auth: req.headers.get('authorization') });
      if (path === '/search') return Response.json({ results: [{ id: 7, memory: 'User likes tea', score: 0.9 }] });
      return Response.json({ ok: true });
    },
  });
  afterAll(() => server.stop(true));

  test('search and add', async () => {
    const m = new HttpMemory({ url: `http://127.0.0.1:${server.port}/`, headers: { authorization: 'Bearer x' } });
    const hits = await m.search('tea', 3);
    expect(hits).toEqual([{ id: '7', title: undefined, content: 'User likes tea', score: 0.9, url: undefined }]);
    await m.write({ title: 'Tea', content: 'User likes tea', tags: ['food'] });
    expect(seen[0]).toEqual({ path: '/search', body: { query: 'tea', limit: 3 }, auth: 'Bearer x' });
    expect(seen[1].path).toBe('/add');
    expect(seen[1].body).toMatchObject({ title: 'Tea', content: 'User likes tea', tags: ['food'] });
  });
});
