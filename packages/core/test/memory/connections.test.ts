import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../../src/config';
import { BasicMemoryAdapter } from '../../src/memory/connections/basic-memory';
import { CogneeAdapter } from '../../src/memory/connections/cognee';
import { HttpMemoryAdapter } from '../../src/memory/connections/http';
import { McpMemoryAdapter } from '../../src/memory/connections/mcp';
import { Mem0Adapter } from '../../src/memory/connections/mem0';
import { MemoryConnections, mergeHits } from '../../src/memory/connections/manager';
import { listConfigured, resolveConnection, validateConnection } from '../../src/memory/connections/registry';
import type { MemoryAdapter, MemoryConnectionConfig } from '../../src/memory/connections/types';
import { explainError, fillTemplate, HttpStatusError } from '../../src/memory/connections/util';
import { serverSpecFromOptions } from '../../src/memory/connections/mcp-client';
import { KNOWLEDGE_GRAPH_DEFAULT_SERVER } from '../../src/memory/connections/mcp';
import { factNote, episodeNote } from '../../src/memory/external';

const FIXTURE = join(import.meta.dir, 'fixtures', 'fake-mcp-server.ts');
const home = mkdtempSync(join(tmpdir(), 'conclave-conn-'));
const config = new ConfigStore(home);
const deps = { config };
/** Every other config folder a test makes; all go when the file is done. */
const homes: string[] = [];
const tmpHome = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  homes.push(d);
  return d;
};
afterAll(() => {
  for (const d of [home, ...homes]) rmSync(d, { recursive: true, force: true });
});

const open: MemoryAdapter[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((a) => a.close?.()));
});

function stdio(flavor: 'basic-memory' | 'kg', env: Record<string, string> = {}) {
  return { command: process.execPath, args: [FIXTURE, flavor], env };
}

function conn(c: MemoryConnectionConfig) {
  return resolveConnection(c);
}

const SEED = JSON.stringify([
  { title: 'Proxmox host', folder: 'infra', content: 'The Proxmox host madx runs LXC containers and PBS backups', tags: [] },
  { title: 'Tailscale', folder: 'infra', content: 'All boxes join the tailnet; MagicDNS names end in ts.net', tags: [] },
  { title: 'Old fact', folder: 'conclave/memories', content: '- [fact] written by conclave earlier', tags: [] },
]);

// ---------------------------------------------------------------------------
// Basic Memory over stdio MCP
// ---------------------------------------------------------------------------

describe('Basic Memory adapter (stdio MCP)', () => {
  test('test(), search, write, and pullAll against a real MCP process', async () => {
    const logFile = join(home, 'bm-calls.jsonl');
    const a = new BasicMemoryAdapter(conn({ id: 'bm', type: 'basic-memory', options: { ...stdio('basic-memory', { FAKE_NOTES: SEED, FAKE_LOG: logFile }), project: 'homelab' } }), deps);
    open.push(a);

    const t = await a.test();
    expect(t.ok).toBe(true);
    expect(t.steps.map((s) => s.step)).toEqual(['connect', 'list tools', 'search']);
    expect(t.tools).toContain('search_notes');
    expect(t.latencyMs).toBeGreaterThanOrEqual(0);

    const hits = await a.search('proxmox backups', 5);
    expect(hits[0]).toMatchObject({ id: 'infra/proxmox-host', title: 'Proxmox host' });

    await a.write(factNote({ content: 'The user prefers bun over npm', kind: 'fact', tags: ['tools'] }));
    // second write of the same title needs overwrite
    await a.write(factNote({ content: 'The user prefers bun over npm', kind: 'fact', tags: ['tools'] }));
    expect((await a.search('bun npm', 5)).some((h) => h.content.includes('prefers bun'))).toBe(true);

    // mirror mode skips the conclave folder on import
    const pulled = await a.pullAll!({ max: 100 });
    expect(pulled.map((p) => p.id).sort()).toEqual(['infra/proxmox-host', 'infra/tailscale']);

    const calls = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(calls.every((c: { args: { project?: string } }) => c.args.project === 'homelab')).toBe(true);
    expect(calls.filter((c: { tool: string }) => c.tool === 'write_note').map((c: { args: { overwrite?: boolean } }) => !!c.args.overwrite)).toEqual([false, false, true]);
  }, 30_000);

  test('falls back when output_format is unknown, pages through notes', async () => {
    const many = JSON.stringify(Array.from({ length: 120 }, (_, i) => ({ title: `Note ${i}`, folder: 'notes', content: `content number ${i}`, tags: [] })));
    const a = new BasicMemoryAdapter(conn({ id: 'bm2', type: 'basic-memory', mode: 'read', options: stdio('basic-memory', { FAKE_NOTES: many, FAKE_NO_JSON: '1' }) }), deps);
    open.push(a);
    expect((await a.search('number', 3)).length).toBe(3);
    const all = await a.pullAll!({ max: 1000 });
    expect(all.length).toBe(120);
  }, 30_000);

  test('test() explains a missing command', async () => {
    const a = new BasicMemoryAdapter(conn({ id: 'bm3', type: 'basic-memory', options: { command: 'definitely-not-a-real-binary-xyz' } }), deps);
    open.push(a);
    const t = await a.test();
    expect(t.ok).toBe(false);
    expect(t.steps[0]).toMatchObject({ step: 'connect', ok: false });
    expect(t.error).toMatch(/Command not found|ENOENT|not found/i);
    expect(t.hint).toBeTruthy();
  }, 30_000);

  test('a server from mcpServers goes through the injected callTool (McpManager ToolOutput shape)', async () => {
    const cfg = new ConfigStore(tmpHome('conclave-conn2-'), { mcpServers: { 'basic-memory': { command: 'uvx' } } });
    const seen: Array<[string, string]> = [];
    const a = new BasicMemoryAdapter(conn({ id: 'bm4', type: 'basic-memory', options: { server: 'basic-memory' } }), {
      config: cfg,
      // McpManager.callTool returns { content: string, isError }
      callTool: async (server, tool) => {
        seen.push([server, tool]);
        return { content: JSON.stringify({ results: [{ title: 'LXC 101', permalink: 'infra/lxc-101', content: 'runs ntfy', score: 0.9 }] }) };
      },
      listTools: async () => ['search_notes', 'write_note'],
    });
    const hits = await a.search('ntfy', 3);
    expect(hits).toEqual([{ id: 'infra/lxc-101', title: 'LXC 101', content: 'runs ntfy', score: 0.9, url: 'memory://infra/lxc-101' }]);
    expect(seen[0]).toEqual(['basic-memory', 'search_notes']);
    expect((await a.test()).ok).toBe(true);

    // McpManager throws for names it does not know
    const missing = new BasicMemoryAdapter(conn({ id: 'bm5', type: 'basic-memory', options: { server: 'nope' } }), {
      config: cfg,
      callTool: async (server) => {
        throw new Error(`unknown mcp server: ${server}`);
      },
    });
    const t = await missing.test();
    expect(t.ok).toBe(false);
    expect(t.error).toBe('No MCP server named "nope"');
    expect(t.hint).toContain('mcpServers');
  });
});

// ---------------------------------------------------------------------------
// generic MCP: knowledge graph preset and custom mapping
// ---------------------------------------------------------------------------

describe('MCP memory adapter', () => {
  test('knowledge-graph preset: create, then add observations, keyword search, read_graph import', async () => {
    const a = new McpMemoryAdapter(conn({ id: 'kg', type: 'mcp', options: { preset: 'knowledge-graph', ...stdio('kg') } }), deps);
    open.push(a);
    const t = await a.test();
    expect(t.ok).toBe(true);
    expect(t.tools).toEqual(['search_nodes', 'create_entities', 'add_observations', 'read_graph']);

    await a.write(factNote({ content: 'The user runs Proxmox on a host called madx', kind: 'fact' }));
    await a.write(factNote({ content: 'The user studies security at university', kind: 'fact' }));
    await a.write(episodeNote({ sessionId: 'ses_123456', summary: 'Fixed the PBS backup job', date: new Date('2026-10-01') }));

    // whole-sentence substring search finds nothing; keyword fallback does
    const hits = await a.search('what does the user run on madx?', 5);
    expect(hits[0].id).toBe('user');
    expect(hits[0].content).toContain('Proxmox');
    expect(hits[0].content).toContain('security');

    const graph = await a.pullAll!({ max: 10 });
    expect(graph.map((g) => g.id).sort()).toEqual(['2026-10-01 Fixed the PBS backup job (123456)', 'user']);
    expect(graph.find((g) => g.id === 'user')!.content).toMatch(/^user \(person\): The user runs Proxmox/);
  }, 30_000);

  test('custom preset maps tool names, arguments and result path', async () => {
    const logFile = join(home, 'custom-calls.jsonl');
    const a = new McpMemoryAdapter(
      conn({
        id: 'custom',
        type: 'mcp',
        options: {
          preset: 'custom',
          ...stdio('basic-memory', { FAKE_NOTES: SEED, FAKE_LOG: logFile }),
          searchTool: 'search_notes',
          searchArgs: { query: '{{query}}', page_size: '{{limit}}', output_format: 'json' },
          writeTool: 'write_note',
          writeArgs: { title: '{{title}}', content: 'From {{kind}}: {{text}}', directory: 'mem', tags: '{{tags}}' },
          resultPath: 'results',
          fields: { id: 'permalink', content: 'content' },
        },
      }),
      deps,
    );
    open.push(a);
    expect((await a.test()).ok).toBe(true);
    const hits = await a.search('tailnet', 2);
    expect(hits).toEqual([{ id: 'infra/tailscale', title: 'Tailscale', content: 'All boxes join the tailnet; MagicDNS names end in ts.net', score: 1, url: undefined }]);
    await a.write(factNote({ content: 'The user likes short answers', kind: 'profile', tags: ['style'] }));
    const calls = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const w = calls.find((c: { tool: string }) => c.tool === 'write_note');
    expect(w.args).toEqual({ title: 'likes short answers', content: 'From profile: The user likes short answers', directory: 'mem', tags: ['conclave', 'profile', 'style'] });
    expect(calls.find((c: { tool: string }) => c.tool === 'search_notes').args).toEqual({ query: 'conclave connection test', page_size: 3, output_format: 'json' });
    expect(a.pullAll).toBeUndefined();
  }, 30_000);

  test('test() names tools the server lacks', async () => {
    const a = new McpMemoryAdapter(conn({ id: 'wrong', type: 'mcp', options: { preset: 'knowledge-graph', ...stdio('basic-memory') } }), deps);
    open.push(a);
    const t = await a.test();
    expect(t.ok).toBe(false);
    expect(t.error).toContain('search_nodes');
    expect(t.hint).toContain('custom');
  }, 30_000);

  test('fillTemplate keeps raw values for whole placeholders', () => {
    expect(fillTemplate({ q: '{{query}}', n: '{{limit}}', s: 'x {{limit}} y', gone: '{{nope}}', list: ['{{tags}}'] }, { query: 'hi', limit: 5, tags: ['a'] })).toEqual({ q: 'hi', n: 5, s: 'x 5 y', list: [['a']] });
  });
});

// ---------------------------------------------------------------------------
// REST adapters against Bun.serve fakes
// ---------------------------------------------------------------------------

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
  form?: Record<string, string[]>;
}

function fakeServer(handler: (req: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const ct = req.headers.get('content-type') ?? '';
      let body: any;
      let form: Record<string, string[]> | undefined;
      if (ct.includes('multipart/form-data')) {
        const fd = await req.formData();
        form = {};
        for (const [k, v] of fd.entries()) (form[k] ??= []).push(typeof v === 'string' ? v : `file:${(v as File).name}:${await (v as File).text()}`);
      } else {
        const t = await req.text();
        body = t ? JSON.parse(t) : undefined;
      }
      const s: Seen = { method: req.method, path: url.pathname + url.search, headers: Object.fromEntries(req.headers.entries()), body, form };
      seen.push(s);
      return handler(s);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) };
}

describe('mem0 adapter', () => {
  test('platform routes, Token auth, filters and paging', async () => {
    const srv = fakeServer((r) => {
      if (r.path === '/v1/ping/') return Response.json({ status: 'ok', orgId: 'o', projectId: 'p' });
      if (r.path === '/v3/memories/search/') return Response.json({ results: [{ id: 'm1', memory: 'Likes tea', score: 0.82 }] });
      if (r.path === '/v3/memories/add/') return Response.json({ results: [{ id: 'm2', memory: 'x', event: 'ADD' }] });
      if (r.path.startsWith('/v3/memories/?page=1')) return Response.json({ count: 2, next: 'page2', results: [{ id: 'm1', memory: 'Likes tea' }] });
      if (r.path.startsWith('/v3/memories/?page=2')) return Response.json({ count: 2, next: null, results: [{ id: 'm3', memory: 'Runs Arch' }] });
      return new Response('nope', { status: 404 });
    });
    try {
      const a = new Mem0Adapter(conn({ id: 'mem0', type: 'mem0', options: { variant: 'platform', url: srv.url, apiKey: 'k-123', userId: 'kai' } }), deps);
      const t = await a.test();
      expect(t.ok).toBe(true);
      expect(t.steps.map((s) => s.step)).toEqual(['ping', 'backend', 'search']);
      expect(await a.search('tea', 3)).toEqual([{ id: 'm1', title: undefined, content: 'Likes tea', score: 0.82, url: undefined }]);
      await a.write(factNote({ content: 'The user drinks tea', kind: 'fact', tags: ['food'] }));
      const pulled = await a.pullAll({ max: 50 });
      expect(pulled.map((p) => p.id)).toEqual(['m1', 'm3']);

      const search = srv.seen.find((s) => s.path === '/v3/memories/search/')!;
      expect(search.headers.authorization).toBe('Token k-123');
      expect(search.body).toEqual({ query: 'conclave connection test', filters: { user_id: 'kai' }, top_k: 3 });
      const add = srv.seen.find((s) => s.path === '/v3/memories/add/')!;
      expect(add.body).toMatchObject({ messages: [{ role: 'user', content: 'The user drinks tea' }], user_id: 'kai', infer: false, metadata: { source: 'conclave', kind: 'fact' } });
    } finally {
      srv.stop();
    }
  });

  test('self-hosted routes and X-API-Key', async () => {
    const srv = fakeServer((r) => {
      if (r.path === '/search') return Response.json({ results: [{ id: 'a', memory: 'Uses Proxmox', score: 0.5 }] });
      if (r.path === '/memories' && r.method === 'POST') return Response.json({ results: [] });
      if (r.path.startsWith('/memories?')) return Response.json({ results: [{ id: 'a', memory: 'Uses Proxmox' }] });
      return new Response('nope', { status: 404 });
    });
    try {
      const a = new Mem0Adapter(conn({ id: 'm', type: 'mem0', options: { url: srv.url, apiKey: 'local-key' } }), deps);
      expect(a.variant).toBe('self-hosted');
      expect((await a.search('proxmox', 2))[0].content).toBe('Uses Proxmox');
      await a.write(factNote({ content: 'The user prefers vim', kind: 'fact' }));
      expect((await a.pullAll({ max: 10 })).length).toBe(1);
      expect(srv.seen[0].headers['x-api-key']).toBe('local-key');
      expect(srv.seen[0].body.filters).toEqual({ user_id: 'conclave' });
      expect(srv.seen[2].path).toBe('/memories?user_id=conclave&top_k=10');
    } finally {
      srv.stop();
    }
  });

  test('401 becomes a clear test() error', async () => {
    const srv = fakeServer(() => new Response('{"detail":"Invalid API key"}', { status: 401 }));
    try {
      const a = new Mem0Adapter(conn({ id: 'm', type: 'mem0', options: { variant: 'platform', url: srv.url, apiKey: 'bad' } }), deps);
      const t = await a.test();
      expect(t.ok).toBe(false);
      expect(t.error).toContain('Not authorized (HTTP 401)');
      expect(t.hint).toContain('API key');
    } finally {
      srv.stop();
    }
  });
});

describe('Cognee adapter', () => {
  test('health, nested search results, remember upload', async () => {
    const srv = fakeServer((r) => {
      if (r.path === '/health') return Response.json({ status: 'ready' });
      if (r.path === '/api/v1/search') return Response.json([{ dataset_id: 'x', dataset_name: 'conclave', search_result: [{ id: 'c1', text: 'madx is the Proxmox host', score: 0.7 }, 'plain string chunk'] }]);
      if (r.path === '/api/v1/remember') return Response.json({ status: 'running' });
      return new Response('nope', { status: 404 });
    });
    try {
      const a = new CogneeAdapter(conn({ id: 'cg', type: 'cognee', options: { url: `${srv.url}/api/v1`, apiKey: 'ck', nodeSet: ['homelab'] } }), deps);
      const t = await a.test();
      expect(t.ok).toBe(true);
      const hits = await a.search('proxmox', 5);
      expect(hits.map((h) => h.content)).toEqual(['madx is the Proxmox host', 'plain string chunk']);
      await a.write(factNote({ content: 'The user backs up with PBS', kind: 'fact' }));
      const search = srv.seen.find((s) => s.path === '/api/v1/search')!;
      expect(search.body).toEqual({ query: 'conclave connection test', search_type: 'CHUNKS', datasets: ['conclave'], top_k: 3 });
      expect(search.headers['x-api-key']).toBe('ck');
      const rem = srv.seen.find((s) => s.path === '/api/v1/remember')!;
      expect(rem.form!.datasetName).toEqual(['conclave']);
      expect(rem.form!.node_set).toEqual(['homelab']);
      expect(rem.form!.run_in_background).toEqual(['true']);
      expect(rem.form!.data[0]).toContain('The user backs up with PBS');
    } finally {
      srv.stop();
    }
  });

  test('older servers: add then cognify; unknown dataset searches empty', async () => {
    const srv = fakeServer((r) => {
      if (r.path === '/api/v1/search') return new Response('{"detail":"Dataset not found"}', { status: 404 });
      if (r.path === '/api/v1/add') return Response.json({ status: 'ok' });
      if (r.path === '/api/v1/cognify') return Response.json({ status: 'running' });
      return new Response('Not Found', { status: 404 });
    });
    try {
      const a = new CogneeAdapter(conn({ id: 'cg', type: 'cognee', options: { url: srv.url, dataset: 'notes' } }), deps);
      expect(await a.search('x', 3)).toEqual([]);
      await a.write(factNote({ content: 'The user uses Arch on the desktop', kind: 'fact' }));
      expect(srv.seen.map((s) => s.path)).toEqual(['/api/v1/search', '/api/v1/remember', '/api/v1/add', '/api/v1/cognify']);
      expect(srv.seen[3].body).toEqual({ datasets: ['notes'], run_in_background: true });
    } finally {
      srv.stop();
    }
  });
});

describe('HTTP adapter', () => {
  test('search, add, optional list import', async () => {
    const srv = fakeServer((r) => {
      if (r.path === '/search') return Response.json([{ id: 1, text: 'Tea at 4', score: 2 }]);
      if (r.path === '/add') return Response.json({ ok: true });
      if (r.path === '/all') return Response.json({ items: [{ id: 'n1', title: 'T', body: 'B' }] });
      return new Response('nope', { status: 404 });
    });
    try {
      const a = new HttpMemoryAdapter(conn({ id: 'h', type: 'http', options: { url: srv.url + '/', headers: { Authorization: 'Bearer z' }, listPath: '/all' } }), deps);
      expect((await a.test()).ok).toBe(true);
      expect((await a.search('tea', 3))[0]).toMatchObject({ id: '1', content: 'Tea at 4', score: 2 });
      await a.write(factNote({ content: 'The user drinks tea at 4', kind: 'fact' }));
      expect(await a.pullAll!({ max: 10 })).toEqual([{ id: 'n1', title: 'T', content: 'B', url: undefined }]);
      expect(srv.seen[0].headers.authorization).toBe('Bearer z');
      const plain = new HttpMemoryAdapter(conn({ id: 'h2', type: 'http', options: { url: srv.url } }), deps);
      expect(plain.pullAll).toBeUndefined();
    } finally {
      srv.stop();
    }
  });

  test('connection refused is explained', async () => {
    const a = new HttpMemoryAdapter(conn({ id: 'h', type: 'http', options: { url: 'http://127.0.0.1:9' } }), deps);
    const t = await a.test();
    expect(t.ok).toBe(false);
    expect(t.error).toMatch(/Connection refused|Unable to connect/);
  });
});

// ---------------------------------------------------------------------------
// manager: merge, isolation, modes
// ---------------------------------------------------------------------------

describe('MemoryConnections', () => {
  function manager(conns: MemoryConnectionConfig[], extra: Record<string, unknown> = {}) {
    const cfg = new ConfigStore(tmpHome('conclave-mgr-'));
    cfg.update({ memory: { ...cfg.get().memory, connections: conns, ...extra } });
    return { cfg, mgr: new MemoryConnections({ config: cfg }) };
  }

  test('searches all, isolates a slow and a broken server, merges and dedupes', async () => {
    const fast = fakeServer((r) => (r.path === '/search' ? Response.json({ results: [{ id: 'a', content: 'The Proxmox host is madx', score: 10 }, { id: 'b', content: 'Backups go to PBS nightly', score: 5 }] }) : Response.json({})));
    const dup = fakeServer((r) => (r.path === '/search' ? Response.json([{ id: 'z', content: 'the proxmox host is madx', score: 0.3 }, { id: 'y', content: 'GLM coding plan via OpenCode', score: 0.2 }]) : Response.json({})));
    const slow = fakeServer(async () => {
      await Bun.sleep(1500);
      return Response.json([{ id: 's', content: 'too late' }]);
    });
    const { mgr } = manager([
      { id: 'fast', type: 'http', options: { url: fast.url } },
      { id: 'dup', type: 'http', options: { url: dup.url } },
      { id: 'slow', type: 'http', timeoutMs: 300, options: { url: slow.url } },
      { id: 'down', type: 'http', options: { url: 'http://127.0.0.1:9' } },
      { id: 'off', type: 'http', enabled: false, options: { url: fast.url } },
      { id: 'nosearch', type: 'http', search: false, options: { url: fast.url } },
    ]);
    try {
      const t0 = performance.now();
      const hits = await mgr.search('proxmox host', 10);
      expect(performance.now() - t0).toBeLessThan(1200);
      expect(hits.map((h) => `${h.source}:${h.id}`)).toEqual(['fast:a', 'dup:y', 'fast:b']);
      expect(hits.some((h) => h.id === 'z')).toBe(false); // near duplicate of fast:a
      expect(hits.some((h) => h.source === 'slow' || h.source === 'down' || h.source === 'off' || h.source === 'nosearch')).toBe(false);
      expect(mgr.statusOf('slow')).toMatchObject({ state: 'error', failures: 1 });
      expect(mgr.statusOf('fast').state).toBe('ok');
      expect(mgr.statusOf('off').state).toBe('disabled');

      // second failure puts it in backoff, then it is skipped (no waiting)
      await mgr.search('proxmox', 5);
      expect(mgr.statusOf('down').state).toBe('backoff');
      const before = slow.seen.length;
      await mgr.search('proxmox', 5);
      expect(slow.seen.length).toBe(before);
    } finally {
      fast.stop();
      dup.stop();
      slow.stop();
      await mgr.close();
    }
  });

  test('writes follow each mode', async () => {
    const a = fakeServer(() => Response.json({ ok: true }));
    const b = fakeServer(() => Response.json({ ok: true }));
    const c = fakeServer(() => new Response('boom', { status: 500 }));
    const { cfg, mgr } = manager([
      { id: 'mirror', type: 'http', mode: 'mirror', options: { url: a.url } },
      { id: 'reader', type: 'http', mode: 'read', options: { url: b.url } },
    ]);
    try {
      expect(mgr.writeMode()).toBe('mirror');
      await mgr.write(factNote({ content: 'The user owns a MacBook', kind: 'fact' }));
      expect(a.seen.filter((s) => s.path === '/add').length).toBe(1);
      expect(b.seen.length).toBe(0);

      cfg.update({ memory: { ...cfg.get().memory, connections: [{ id: 'primary', type: 'http', mode: 'external', options: { url: c.url } }, { id: 'mirror', type: 'http', mode: 'mirror', options: { url: a.url } }] } });
      expect(mgr.writeMode()).toBe('external');
      // the external target failed, so the store must keep the memory locally
      await expect(mgr.write(factNote({ content: 'The user owns an Arch desktop', kind: 'fact' }))).rejects.toThrow(/primary/);

      cfg.update({ memory: { ...cfg.get().memory, connections: [{ id: 'reader', type: 'http', mode: 'read', options: { url: b.url } }] } });
      expect(mgr.writeMode()).toBeUndefined();
    } finally {
      a.stop();
      b.stop();
      c.stop();
      await mgr.close();
    }
  });

  test('legacy memory.external shows up as connection "external"', () => {
    const { mgr } = manager([], { external: { type: 'mcp', mcpServer: 'basic-memory', project: 'main', mode: 'external' } });
    expect(mgr.list()).toEqual([
      expect.objectContaining({ id: 'external', type: 'basic-memory', mode: 'external', legacy: true, options: { server: 'basic-memory', project: 'main' } }),
    ]);
    const explicit = listConfigured({ enabled: true, autoExtract: true, autoInject: true, injectLimit: 6, external: { type: 'http', url: 'http://x', mode: 'mirror' }, connections: [{ id: 'external', type: 'mem0', options: { apiKey: 'k' } }] });
    expect(explicit.map((c) => c.type)).toEqual(['mem0']);
  });

  test('mergeHits normalizes per connection', () => {
    const merged = mergeHits(
      [
        { conn: { id: 'a' }, hits: [{ id: '1', content: 'alpha beta gamma', score: 100 }, { id: '2', content: 'delta epsilon zeta', score: 50 }] },
        { conn: { id: 'b' }, hits: [{ id: '3', content: 'eta theta iota', score: 0.9 }] },
      ],
      10,
    );
    expect(merged.map((h) => [h.source, h.id, h.score])).toEqual([
      ['a', '1', 1],
      ['b', '3', 1],
      ['a', '2', 0.5],
    ]);
  });
});

describe('validateConnection', () => {
  const cases: Array<[string, any, RegExp]> = [
    ['bad id', { id: 'Bad Id', type: 'http', options: { url: 'http://x' } }, /id must be/],
    ['bad type', { id: 'x', type: 'redis' }, /type must be/],
    ['bad mode', { id: 'x', type: 'http', mode: 'both', options: { url: 'http://x' } }, /mode must be/],
    ['http needs url', { id: 'x', type: 'http', options: {} }, /options.url is required/],
    ['url scheme', { id: 'x', type: 'http', options: { url: 'ftp://x' } }, /http or https/],
    ['platform key', { id: 'x', type: 'mem0', options: {} }, /apiKey is required/],
    ['custom needs searchTool', { id: 'x', type: 'mcp', options: { preset: 'custom', server: 's' } }, /searchTool is required/],
    ['custom read only', { id: 'x', type: 'mcp', options: { preset: 'custom', server: 's', searchTool: 'find' } }, /mode "read"/],
    ['one server source', { id: 'x', type: 'basic-memory', options: { server: 'a', url: 'http://b' } }, /only one of/],
    ['timeout range', { id: 'x', type: 'http', timeoutMs: 5, options: { url: 'http://x' } }, /timeoutMs/],
  ];
  for (const [name, c, re] of cases) {
    test(name, () => {
      let err: any;
      try {
        validateConnection(c);
      } catch (e) {
        err = e;
      }
      expect(err?.status).toBe(400);
      expect(err?.message).toMatch(re);
    });
  }
  test('accepts secret references and defaults', () => {
    expect(() => validateConnection({ id: 'm', type: 'mem0', options: { apiKey: '${secret:mem0}' } })).not.toThrow();
    expect(() => validateConnection({ id: 'c', type: 'cognee', options: { url: '${env:COGNEE_URL}' } })).not.toThrow();
    expect(() => validateConnection({ id: 'bm', type: 'basic-memory' })).not.toThrow();
    expect(() => validateConnection({ id: 'kg', type: 'mcp' })).not.toThrow();
    expect(() => validateConnection({ id: 'dup', type: 'mcp' }, ['dup'])).toThrow(/already exists/);
  });
});

describe('error words and default servers', () => {
  test('a 401 without a context url names the request url, never a dangling "at"', () => {
    const e = explainError(new HttpStatusError(401, 'https://api.mem0.ai/v3/memories/?page=1', '{}'));
    expect(e.error).toBe('Not authorized (HTTP 401) at https://api.mem0.ai/v3/memories/?page=1');
    expect(explainError(new HttpStatusError(403, '', '')).error).toBe('Not authorized (HTTP 403)');
    expect(explainError(new HttpStatusError(403, 'https://x.example/a', ''), { url: 'https://api.mem0.ai' }).error).toBe('Not authorized (HTTP 403) at https://api.mem0.ai');
  });

  test('the default knowledge graph server keeps options.env', () => {
    const spec = serverSpecFromOptions({ preset: 'knowledge-graph', env: { MEMORY_FILE_PATH: '/data/graph.jsonl', EMPTY: '' } }, KNOWLEDGE_GRAPH_DEFAULT_SERVER);
    expect(spec.inline?.command).toBe('npx');
    expect(spec.inline?.env).toEqual({ MEMORY_FILE_PATH: '/data/graph.jsonl' });
    expect(serverSpecFromOptions({}, KNOWLEDGE_GRAPH_DEFAULT_SERVER).inline).toBe(KNOWLEDGE_GRAPH_DEFAULT_SERVER);
  });
});
