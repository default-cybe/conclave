import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkHealth, localUrl, readLocalHub, resolveHub, type LocalHub } from '../src/hub';
import { normalizeHubUrl, readClientFile, writePrivateJson, type ClientFile } from '../src/files';

const local: LocalHub = { url: 'http://127.0.0.1:7717', token: 'owner-token', host: '127.0.0.1', port: 7717 };
const client: ClientFile = { hub: 'https://box.tail1234.ts.net', token: 'client-token', savedAt: 1 };

describe('resolveHub order', () => {
  test('flags win over everything', () => {
    const t = resolveHub({ flags: { hub: 'http://flag:1', token: 'ft' }, env: { CONCLAVE_HUB: 'http://env:2', CONCLAVE_TOKEN: 'et' }, client, local });
    expect(t).toEqual({ url: 'http://flag:1', token: 'ft', source: 'flag', local: false });
  });

  test('env comes next', () => {
    const t = resolveHub({ flags: {}, env: { CONCLAVE_HUB: 'http://env:2', CONCLAVE_TOKEN: 'et' }, client, local });
    expect(t).toEqual({ url: 'http://env:2', token: 'et', source: 'env', local: false });
  });

  test('then client.json', () => {
    const t = resolveHub({ flags: {}, env: {}, client, local });
    expect(t).toEqual({ url: 'https://box.tail1234.ts.net', token: 'client-token', source: 'client', local: false });
  });

  test('then the local hub from config.json, which may be auto-started', () => {
    const t = resolveHub({ flags: {}, env: {}, local });
    expect(t).toEqual({ url: 'http://127.0.0.1:7717', token: 'owner-token', source: 'local', local: true });
  });

  test('CONCLAVE_TOKEN alone applies to the local hub', () => {
    expect(resolveHub({ flags: {}, env: { CONCLAVE_TOKEN: 'envtok' }, local })).toMatchObject({ token: 'envtok', source: 'local', local: true });
  });

  test('a token flag applies to the saved hub', () => {
    expect(resolveHub({ flags: { token: 'x' }, env: {}, client, local }).token).toBe('x');
  });

  test('--hub pointing at the saved hub reuses its token', () => {
    expect(resolveHub({ flags: { hub: 'box.tail1234.ts.net' }, env: {}, client, local }).token).toBe('client-token');
  });

  test("the saved hub's key goes with any of its addresses, and with no other hub", () => {
    const pinned: ClientFile = { ...client, hubKey: 'key-a', addresses: ['https://box.tail1234.ts.net', 'http://192.168.1.5:7717'] };
    expect(resolveHub({ flags: {}, env: {}, client: pinned, local }).hubKey).toBe('key-a');
    expect(resolveHub({ flags: { hub: '192.168.1.5:7717' }, env: {}, client: pinned, local }).hubKey).toBe('key-a');
    expect(resolveHub({ flags: {}, env: { CONCLAVE_HUB: 'https://box.tail1234.ts.net' }, client: pinned, local }).hubKey).toBe('key-a');
    expect(resolveHub({ flags: { hub: 'https://elsewhere.example.com' }, env: {}, client: pinned, local }).hubKey).toBeUndefined();
    expect(resolveHub({ flags: {}, env: {}, local }).hubKey).toBeUndefined();
  });

  test('--hub pointing at the local hub reuses the owner token', () => {
    const t = resolveHub({ flags: { hub: 'localhost:7717' }, env: {}, local });
    expect(t.url).toBe('http://localhost:7717');
    expect(t.token).toBe('owner-token');
  });
});

describe('normalizeHubUrl', () => {
  test('adds a scheme and trims', () => {
    expect(normalizeHubUrl('127.0.0.1:7717/')).toBe('http://127.0.0.1:7717');
    expect(normalizeHubUrl('box.ts.net')).toBe('https://box.ts.net');
    expect(normalizeHubUrl('https://hub.example.com/api')).toBe('https://hub.example.com');
    expect(normalizeHubUrl('ws://h:1')).toBe('http://h:1');
  });
});

describe('local config files', () => {
  const home = mkdtempSync(join(tmpdir(), 'conclave-hub-'));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  test('reads server host/port/token, maps 0.0.0.0 to loopback, accepts JSONC', () => {
    writeFileSync(join(home, 'config.json'), '{\n // comment\n "server": { "host": "0.0.0.0", "port": 7800, "token": "abc", },\n}\n');
    expect(readLocalHub(home, {})).toEqual({ url: 'http://127.0.0.1:7800', token: 'abc', host: '127.0.0.1', port: 7800 });
  });

  test('env overrides like the hub does', () => {
    expect(readLocalHub(home, { CONCLAVE_PORT: '9000' }).url).toBe('http://127.0.0.1:9000');
  });

  test('the local URL for `conclave serve --host`: IPv6 in brackets, a wildcard on loopback', () => {
    expect(localUrl('::1', 7717)).toBe('http://[::1]:7717');
    expect(localUrl('[::1]', 7717)).toBe('http://[::1]:7717');
    expect(localUrl('[::]', 7717)).toBe('http://127.0.0.1:7717');
    expect(localUrl('192.168.1.5', 80)).toBe('http://192.168.1.5:80');
  });

  test('defaults when there is no config', () => {
    const empty = mkdtempSync(join(tmpdir(), 'conclave-hub-empty-'));
    expect(readLocalHub(empty, {})).toEqual({ url: 'http://127.0.0.1:7717', token: undefined, host: '127.0.0.1', port: 7717 });
    rmSync(empty, { recursive: true, force: true });
  });

  test('client.json is written 0600 and read back', () => {
    writePrivateJson(join(home, 'client.json'), client);
    expect(readClientFile(home)).toEqual(client);
    if (process.platform !== 'win32') expect(statSync(join(home, 'client.json')).mode & 0o777).toBe(0o600);
  });
});

describe('checkHealth', () => {
  test('refused when nothing listens', async () => {
    const h = await checkHealth('http://127.0.0.1:1', 1000);
    expect(h.ok).toBe(false);
  });

  test('ok against a server', async () => {
    const srv = Bun.serve({ port: 0, fetch: (req) => (new URL(req.url).pathname === '/api/health' ? Response.json({ ok: true }) : new Response('no', { status: 404 })) });
    expect((await checkHealth(`http://127.0.0.1:${srv.port}`)).ok).toBe(true);
    srv.stop(true);
  });
});
