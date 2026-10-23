import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { WebFetchTool, clearWebFetchCache, guardHost, isMetadataAddress, setWebFetchLookup } from '../../src/tools/webfetch';
import { makeCtx, text } from './helpers';

/**
 * HARNESS-REVIEW item 10 (WebFetch part): the host is resolved once, cloud
 * metadata addresses are refused on the first hop and every redirect hop,
 * and plain http connects to the address that was checked. LAN hosts stay
 * reachable by design.
 */

let server: ReturnType<typeof Bun.serve>;
let lastHost = '';
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      lastHost = req.headers.get('host') ?? '';
      const path = new URL(req.url).pathname;
      if (path === '/to-metadata') return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
      if (path === '/hop') return new Response(null, { status: 302, headers: { location: '/second' } });
      return new Response('lan page', { headers: { 'content-type': 'text/plain' } });
    },
  });
});
afterAll(() => server.stop(true));
afterEach(() => {
  setWebFetchLookup();
  clearWebFetchCache();
});

const ctx = () => makeCtx({ cwd: '/' });

describe('cloud metadata guard', () => {
  test('metadata addresses in every spelling; LAN and public addresses pass', () => {
    for (const ip of ['169.254.169.254', '169.254.0.1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', 'fd00:ec2::254', '[fd00:ec2::254]', '100.100.100.200', '168.63.129.16']) expect(isMetadataAddress(ip)).toBe(true);
    for (const ip of ['10.0.0.1', '192.168.1.20', '172.16.0.5', '127.0.0.1', '100.64.0.1', '8.8.8.8', '::1', 'fd00::1']) expect(isMetadataAddress(ip)).toBe(false);
  });

  test('refused by address, by name and through a name that resolves to one', async () => {
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://2852039166/', 'http://[fd00:ec2::254]/', 'http://metadata.google.internal/computeMetadata/v1/']) {
      const out = await WebFetchTool.run({ url }, ctx());
      expect(out.isError).toBe(true);
      expect(text(out)).toContain('WebFetch never fetches instance metadata');
    }
    setWebFetchLookup(async (h) => (h === 'evil.local' ? ['10.0.0.9', '169.254.169.254'] : ['127.0.0.1']));
    expect(await guardHost(new URL('http://evil.local/'))).toEqual({ error: 'Refused: evil.local resolves to 169.254.169.254, a cloud metadata address. WebFetch never fetches instance metadata.' });
  });

  test('a redirect to a metadata address is not followed, and fetching it next is refused', async () => {
    const first = await WebFetchTool.run({ url: `http://127.0.0.1:${server.port}/to-metadata` }, ctx());
    // another host: reported, not followed (and upgraded to https, as for any non-LAN host)
    expect(text(first)).toContain('Redirect (HTTP 302): https://169.254.169.254/latest/meta-data/');
    const second = await WebFetchTool.run({ url: 'https://169.254.169.254/latest/meta-data/' }, ctx());
    expect(second.isError).toBe(true);
  });

  test('each redirect hop is checked again, so a name that rebinds between hops is refused', async () => {
    let n = 0;
    setWebFetchLookup(async () => (n++ === 0 ? ['127.0.0.1'] : ['169.254.169.254']));
    const out = await WebFetchTool.run({ url: `http://rebind.local:${server.port}/hop` }, ctx());
    expect(out.isError).toBe(true);
    expect(text(out)).toContain('rebind.local resolves to 169.254.169.254');
    expect(n).toBe(2);
  });

  test('plain http connects to the address resolved once, with the name in the Host header', async () => {
    let lookups = 0;
    setWebFetchLookup(async () => {
      lookups++;
      return ['127.0.0.1'];
    });
    const out = await WebFetchTool.run({ url: `http://printer.local:${server.port}/status` }, ctx());
    expect(out.isError).toBeFalsy();
    expect(text(out)).toContain('lan page');
    expect(lastHost).toBe(`printer.local:${server.port}`);
    expect(lookups).toBe(1);
  });
});
