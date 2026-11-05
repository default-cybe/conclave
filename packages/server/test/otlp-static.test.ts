import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { OtlpIngest } from '../src/otlp';
import { pickEncoding } from '../src/static';
import { OWNER, startHub, type TestHub } from './helpers';

const kv = (key: string, value: string) => ({ key, value: { stringValue: value } });

function metrics(points: Array<{ metric: string; type?: string; model: string; value: number; time: string; start?: string }>, temporality = 1) {
  const byMetric = new Map<string, unknown[]>();
  for (const p of points) {
    const attrs = [kv('session.id', 'cc-session-1'), kv('model', p.model)];
    if (p.type) attrs.push(kv('type', p.type));
    const list = byMetric.get(p.metric) ?? [];
    list.push({ attributes: attrs, startTimeUnixNano: p.start ?? '1700000000000000000', timeUnixNano: p.time, asDouble: p.value });
    byMetric.set(p.metric, list);
  }
  return {
    resourceMetrics: [
      {
        resource: { attributes: [kv('service.name', 'claude-code'), kv('user.id', 'u1')] },
        scopeMetrics: [
          {
            scope: { name: 'com.anthropic.claude_code' },
            metrics: [...byMetric].map(([name, dataPoints]) => ({ name, unit: 'tokens', sum: { dataPoints, aggregationTemporality: temporality, isMonotonic: true } })),
          },
        ],
      },
    ],
  };
}

let hub: TestHub;
let webDir: string;

beforeAll(() => {
  webDir = mkdtempSync(join(tmpdir(), 'conclave-web-'));
  mkdirSync(join(webDir, 'assets'));
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>app</title>');
  writeFileSync(join(webDir, 'sw.js'), 'self.addEventListener("fetch", () => {})');
  writeFileSync(join(webDir, 'assets', 'index-B2x9_aQz.js'), 'console.log(1)');
  writeFileSync(join(webDir, 'manifest.webmanifest'), '{}');
  writeFileSync(join(webDir, 'logo.svg'), '<svg/>');
  writeFileSync(join(webDir, 'assets', 'main-C8JE50pm.js'), 'export const rows = [];\n'.repeat(400));
  writeFileSync(join(webDir, 'assets', 'font-Bw9x6K1M.woff2'), 'x'.repeat(4000));
  hub = startHub({ webDir });
});
afterAll(async () => {
  await hub.stop();
  rmSync(webDir, { recursive: true, force: true });
});

describe('OTLP ingest', () => {
  test('claude_code token and cost metrics become usage records', async () => {
    const key = (await hub.api('/api/gateway/keys', { method: 'POST', json: { name: 'otel' } }).then((r) => r.json())).key;
    const body = metrics([
      { metric: 'claude_code.token.usage', type: 'input', model: 'claude-sonnet-test', value: 100, time: '1760000000000000000' },
      { metric: 'claude_code.token.usage', type: 'output', model: 'claude-sonnet-test', value: 40, time: '1760000000000000000' },
      { metric: 'claude_code.token.usage', type: 'cacheRead', model: 'claude-sonnet-test', value: 5000, time: '1760000000000000000' },
      { metric: 'claude_code.token.usage', type: 'cacheCreation', model: 'claude-sonnet-test', value: 300, time: '1760000000000000000' },
      { metric: 'claude_code.cost.usage', model: 'claude-sonnet-test', value: 0.0123, time: '1760000000000000000' },
      { metric: 'claude_code.token.usage', type: 'input', model: 'claude-haiku-test', value: 7, time: '1760000000000000000' },
    ]);
    const res = await fetch(`${hub.url}/v1/metrics`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    const rows = hub.engine.repos.usage.recent(10, { source: 'claude-code-otel' });
    expect(rows).toHaveLength(2);
    const sonnet = rows.find((r) => r.model === 'claude-sonnet-test')!;
    expect(sonnet).toMatchObject({ inputTokens: 100, outputTokens: 40, cacheReadTokens: 5000, cacheWriteTokens: 300, provider: 'anthropic', ts: 1760000000000 });
    expect(sonnet.costUsd).toBeCloseTo(0.0123);
    // the same export again is deduplicated
    await fetch(`${hub.url}/v1/metrics`, { method: 'POST', headers: { authorization: `Bearer ${OWNER}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(hub.engine.repos.usage.recent(10, { source: 'claude-code-otel' })).toHaveLength(2);
  });

  test('auth and protobuf', async () => {
    expect((await fetch(`${hub.url}/v1/metrics`, { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await fetch(`${hub.url}/v1/metrics`, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' })).status).toBe(401);
    const pb = await fetch(`${hub.url}/v1/metrics`, { method: 'POST', headers: { authorization: `Bearer ${OWNER}`, 'content-type': 'application/x-protobuf' }, body: 'x' });
    expect(pb.status).toBe(415);
    expect((await fetch(`${hub.url}/v1/logs`, { method: 'POST', headers: { authorization: `Bearer ${OWNER}` }, body: '{}' })).status).toBe(200);
  });

  test('cumulative series become deltas', () => {
    const ingest = new OtlpIngest();
    const a = ingest.convert(metrics([{ metric: 'claude_code.token.usage', type: 'output', model: 'm', value: 10, time: '1' }], 2));
    const b = ingest.convert(metrics([{ metric: 'claude_code.token.usage', type: 'output', model: 'm', value: 25, time: '2' }], 2));
    expect(a[0].record.outputTokens).toBe(10);
    expect(b[0].record.outputTokens).toBe(15);
    // a new start time is a new series (process restarted)
    const c = ingest.convert(metrics([{ metric: 'claude_code.token.usage', type: 'output', model: 'm', value: 4, time: '3', start: '5' }], 2));
    expect(c[0].record.outputTokens).toBe(4);
  });
});

describe('static web app', () => {
  test('index with no-cache, CSP and security headers', async () => {
    const res = await fetch(`${hub.url}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>app</title>');
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'self' ws: wss:");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  test('hashed assets cache forever, sw.js never', async () => {
    const js = await fetch(`${hub.url}/assets/index-B2x9_aQz.js`);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const sw = await fetch(`${hub.url}/sw.js`);
    expect(sw.headers.get('cache-control')).toBe('no-cache');
    expect((await fetch(`${hub.url}/manifest.webmanifest`)).headers.get('content-type')).toBe('application/manifest+json');
    expect((await fetch(`${hub.url}/logo.svg`)).headers.get('content-type')).toBe('image/svg+xml');
  });

  test('text assets go out brotli or gzip, with the same bytes and caching', async () => {
    const raw = 'export const rows = [];\n'.repeat(400);
    const get = (enc: string) => fetch(`${hub.url}/assets/main-C8JE50pm.js`, { headers: { 'accept-encoding': enc }, decompress: false } as RequestInit);
    const br = await get('gzip, deflate, br');
    expect(br.headers.get('content-encoding')).toBe('br');
    expect(br.headers.get('vary')).toBe('accept-encoding');
    expect(br.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const brBytes = Buffer.from(await br.arrayBuffer());
    expect(Number(br.headers.get('content-length'))).toBe(brBytes.length);
    expect(brBytes.length).toBeLessThan(raw.length / 10);
    expect(brotliDecompressSync(brBytes).toString()).toBe(raw);
    const gz = await get('gzip');
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    expect(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString()).toBe(raw);
    const plain = await get('identity');
    expect(plain.headers.get('content-encoding')).toBeNull();
    expect(await plain.text()).toBe(raw);
    // fonts are compressed already; tiny files are not worth it
    expect((await fetch(`${hub.url}/assets/font-Bw9x6K1M.woff2`, { headers: { 'accept-encoding': 'br' }, decompress: false } as RequestInit)).headers.get('content-encoding')).toBeNull();
    expect((await fetch(`${hub.url}/assets/index-B2x9_aQz.js`, { headers: { 'accept-encoding': 'br' }, decompress: false } as RequestInit)).headers.get('content-encoding')).toBeNull();
  });

  test('pickEncoding honours q=0 and prefers br', () => {
    expect(pickEncoding('gzip, br', '/a.js', 5000)).toBe('br');
    expect(pickEncoding('br;q=0, gzip', '/a.js', 5000)).toBe('gzip');
    expect(pickEncoding('gzip;q=0', '/a.js', 5000)).toBeUndefined();
    expect(pickEncoding('br', '/a.png', 5000)).toBeUndefined();
    expect(pickEncoding(undefined, '/a.js', 5000)).toBeUndefined();
  });

  test('API JSON goes out gzipped when the client takes it', async () => {
    const get = (enc: string) => fetch(`${hub.url}/api/agents`, { headers: { authorization: `Bearer ${OWNER}`, 'accept-encoding': enc }, decompress: false } as RequestInit);
    const gz = await get('gzip, br');
    expect(gz.status).toBe(200);
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    const body = JSON.parse(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString());
    const plain = await get('identity');
    expect(plain.headers.get('content-encoding')).toBeNull();
    expect(body).toEqual(await plain.json());
  });

  test('SPA fallback for routes, 404 for missing files and traversal', async () => {
    const route = await fetch(`${hub.url}/s/ses_123`);
    expect(route.status).toBe(200);
    expect(await route.text()).toContain('<title>app</title>');
    expect((await fetch(`${hub.url}/assets/missing-abcdefgh.js`)).status).toBe(404);
    // dot segments are normalized by the URL parser, so this lands on the SPA, not the file
    const dots = await fetch(`${hub.url}/%2e%2e/%2e%2e/etc/passwd`);
    expect(await dots.text()).toContain('<title>app</title>');
    // encoded slashes survive URL parsing and must be caught by the server
    expect((await fetch(`${hub.url}/..%2F..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
    expect((await fetch(`${hub.url}/assets%2F..%2F..%2Fpackage.json`)).status).toBe(404);
    expect((await fetch(`${hub.url}/api/unknown`, { headers: { authorization: `Bearer ${OWNER}` } })).status).toBe(404);
  });
});

describe('the page when there is no web build', () => {
  test('names the places this hub looks, its home first, escaped', async () => {
    const { placeholderPage } = await import('../src/static');
    const res = placeholderPage('1.2.3', ['/data/hub/web', '/opt/conclave/web', '/$bunfs/root/web/dist', '/opt/<b>/web', '/data/hub/web']);
    const html = await res.text();
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(html).toContain('<code>/data/hub/web</code>');
    expect(html).toContain('<code>/opt/conclave/web</code>');
    expect(html.indexOf('/data/hub/web')).toBeLessThan(html.indexOf('/opt/conclave/web'));
    // the compiled binary's own bundle is no place to put anything, and nothing in a path becomes markup
    expect(html).not.toContain('$bunfs');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
    // the old advice, wrong for a hub whose home is not ~/.conclave
    expect(html).not.toContain('~/.conclave/web');
    expect(html.match(/\/data\/hub\/web/g)).toHaveLength(1);
  });
});
