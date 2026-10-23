import { afterEach, expect, test } from 'bun:test';
import type { Context } from 'hono';
import { clientIp, setTrustedProxies } from '../src/http';

// a request as Bun.serve hands it over: the socket peer, and the headers a proxy or the client set
function ctx(peer: string, headers: Record<string, string> = {}): Context {
  const raw = new Request('http://hub/api/x', { headers });
  return { env: { requestIP: () => ({ address: peer }) }, req: { raw, header: (n: string) => raw.headers.get(n) ?? undefined } } as unknown as Context;
}

afterEach(() => setTrustedProxies([]));

test('a proxy on loopback passes on the visitor, the last forwarded entry', () => {
  expect(clientIp(ctx('127.0.0.1', { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }))).toBe('203.0.113.9');
  expect(clientIp(ctx('::1', { 'cf-connecting-ip': '203.0.113.7' }))).toBe('203.0.113.7');
});

test('a machine on the network is itself, whatever its headers say', () => {
  expect(clientIp(ctx('192.168.1.20', { 'x-forwarded-for': '203.0.113.9' }))).toBe('192.168.1.20');
});

test('server.trustedProxies: cloudflared on another machine passes on the visitor', () => {
  setTrustedProxies(['192.168.1.20']);
  expect(clientIp(ctx('192.168.1.20', { 'x-forwarded-for': '203.0.113.9' }))).toBe('203.0.113.9');
  expect(clientIp(ctx('::ffff:192.168.1.20', { 'cf-connecting-ip': '203.0.113.8' }))).toBe('203.0.113.8');
  // without a header it is the proxy itself
  expect(clientIp(ctx('192.168.1.20'))).toBe('192.168.1.20');
  // another machine on the network still cannot claim an address
  expect(clientIp(ctx('192.168.1.21', { 'x-forwarded-for': '203.0.113.9' }))).toBe('192.168.1.21');
});

test('a bad trustedProxies value trusts nobody instead of throwing', () => {
  setTrustedProxies('192.168.1.20');
  expect(clientIp(ctx('192.168.1.20', { 'x-forwarded-for': '203.0.113.9' }))).toBe('192.168.1.20');
  setTrustedProxies([42, '192.168.1.20']);
  expect(clientIp(ctx('192.168.1.20', { 'x-forwarded-for': '203.0.113.9' }))).toBe('203.0.113.9');
});
