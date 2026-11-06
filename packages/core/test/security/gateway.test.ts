/**
 * Security mode PR 1b (docs/design/SECURITY-MODE.md section 6): approval
 * grants and the egress gateway. Every upstream is a local listener: the
 * gateway's dial is pointed at it, so no test reaches a real host.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer as httpServer, request, type Server } from 'node:http';
import { connect, createServer as tcpServer, type Server as TcpServer } from 'node:net';
import { EgressGateway, gatewayDecide } from '../../src/security/gateway';
import { addGrant, checkGrant, countUse, coveringGrant, grantsOf, revokeGrant } from '../../src/security/grants';
import { GRANTS_KV, GRANT_MAX_MS, decide, parseScope, type ScopeGrant, type ScopeState } from '../../src/security/scope';
import { egressEnv, egressLogPath, stopEgress, type EgressHost } from '../../src/session/egress';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, FakeMachine, tempDir } from '../extensions/_helpers';
import type { AgentDef } from '../../src/extensions/types';
import type { Session } from '../../src/types';

const scope = parseScope('program: acme\nin_scope: ["app.acme.com"]\npaths: ["/api/**"]\nout_of_scope: ["admin.acme.com"]\nlab: ["sec-lab-acme"]\nrate_limit_rps: 2\nrequest_budget: 300\naccounts: ["attacker"]\n');
const ok: ScopeState = { kind: 'ok', scopes: [scope], files: ['/hunt/targets/acme/scope.yaml'] };
const NOW = Date.UTC(2026, 10, 6, 12);

function memKv() {
  const m = new Map<string, unknown>();
  return { get: <T>(k: string, f: T) => (m.has(k) ? (structuredClone(m.get(k)) as T) : f), set: (k: string, v: unknown) => void m.set(k, structuredClone(v)) };
}

describe('grants', () => {
  test('checkGrant: in-scope hosts only, capped by scope.yaml and 500', () => {
    const c = checkGrant({ hosts: ['app.acme.com'], accounts: ['attacker'], requestBudget: 9_000, rateRps: 10 }, [scope]);
    expect(c.ok && c.grant).toMatchObject({ hosts: ['app.acme.com'], requestBudget: 300, rateRps: 2, used: 0 });
    expect(checkGrant({ hosts: ['admin.acme.com'] }, [scope]).ok).toBe(false);
    expect(checkGrant({ hosts: ['localhost'] }, [scope]).ok).toBe(false);
    expect(checkGrant({ hosts: ['evil.com'] }, [scope]).ok).toBe(false);
    expect(checkGrant({ hosts: ['app.acme.com'], accounts: ['root'] }, [scope]).ok).toBe(false);
    const big = parseScope('program: b\nin_scope: [b.com]\nrequest_budget: 5000\n');
    const b = checkGrant({ hosts: ['b.com'] }, [big]);
    expect(b.ok && b.grant.requestBudget).toBe(500);
  });

  test('add, count, revoke in kv security.grants; 24 h term; a live grant covers later asks', () => {
    const kv = memKv();
    const c = checkGrant({ hosts: ['app.acme.com'] }, [scope]);
    if (!c.ok) throw new Error(c.why);
    const g = addGrant(kv, 'hunt', c.grant, NOW, 'g1');
    expect(g.expiresAt - g.issuedAt).toBe(GRANT_MAX_MS);
    expect(Object.keys(kv.get(GRANTS_KV, {}))).toEqual(['hunt']);
    expect(countUse(kv, 'hunt', 'g1')).toBe(1);
    expect(coveringGrant(grantsOf(kv, 'hunt'), ['APP.acme.com.'], NOW)?.id).toBe('g1');
    expect(revokeGrant(kv, 'hunt', 'g1', NOW)?.revokedAt).toBe(NOW);
    expect(coveringGrant(grantsOf(kv, 'hunt'), ['app.acme.com'], NOW)).toBeUndefined();
    expect(revokeGrant(kv, 'hunt', 'nope')).toBeUndefined();
  });
});

describe('gatewayDecide', () => {
  const g = (over: Partial<ScopeGrant> = {}): ScopeGrant => ({ id: 'g1', hosts: ['app.acme.com'], accounts: [], requestBudget: 3, used: 0, rateRps: 2, issuedAt: NOW - 1000, expiresAt: NOW + 3_600_000, scope, ...over });
  test('in scope without a grant is refused; lab passes; out of scope and unlisted refused', () => {
    expect(gatewayDecide(ok, [], 'app.acme.com', '/api/x', NOW)).toMatchObject({ allow: false, status: 403 });
    expect(gatewayDecide(ok, [], 'app.acme.com', '/api/x', NOW).reason).toMatch(/no approval grant/);
    expect(gatewayDecide(ok, [], '127.0.0.1', '/', NOW)).toMatchObject({ allow: true, lab: true });
    expect(gatewayDecide(ok, [], 'web.sec-lab-acme', '/', NOW).allow).toBe(true);
    expect(gatewayDecide(ok, [g()], 'admin.acme.com', '/', NOW).reason).toMatch(/out of scope/);
    expect(gatewayDecide(ok, [g()], 'app.acme.com', '/billing', NOW).reason).toMatch(/outside the in-scope paths/);
    expect(gatewayDecide(ok, [g()], 'example.org', '/', NOW).reason).toMatch(/not in scope/);
    expect(gatewayDecide({ kind: 'none' }, [], 'localhost', '/', NOW).allow).toBe(true);
  });
  test('expired, revoked and spent grants are refused; the pinned scope cannot be widened by editing scope.yaml', () => {
    expect(gatewayDecide(ok, [g({ expiresAt: NOW - 1 })], 'app.acme.com', '/api', NOW).reason).toMatch(/expired/);
    expect(gatewayDecide(ok, [g({ revokedAt: NOW - 1 })], 'app.acme.com', '/api', NOW).reason).toMatch(/revoked/);
    expect(gatewayDecide(ok, [g({ used: 3 })], 'app.acme.com', '/api', NOW).reason).toMatch(/budget/);
    const wider = parseScope('program: acme\nin_scope: ["app.acme.com"]\n');
    expect(gatewayDecide({ kind: 'ok', scopes: [wider], files: [] }, [g()], 'app.acme.com', '/billing', NOW).allow).toBe(false);
  });
  test('egress.log lands in findings/<t>-hunt', () => {
    expect(egressLogPath('/hunt', ok, 'app.acme.com')).toBe('/hunt/findings/acme-hunt/egress.log');
  });
});

describe('the gateway on the wire (local listeners only)', () => {
  let upstream: Server;
  let tls: TcpServer;
  let upPort = 0;
  let tlsPort = 0;
  const hits: string[] = [];
  beforeAll(async () => {
    upstream = httpServer((req, res) => {
      hits.push(`${req.headers.host} ${req.url} ${req.headers['proxy-authorization'] ? 'leaked' : 'clean'}`);
      res.end('hello from upstream');
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    upPort = (upstream.address() as { port: number }).port;
    tls = tcpServer((s) => s.on('data', (d) => s.write(`echo:${d}`)));
    await new Promise<void>((r) => tls.listen(0, '127.0.0.1', () => r()));
    tlsPort = (tls.address() as { port: number }).port;
  });
  afterAll(() => {
    upstream.close();
    tls.close();
  });

  function setup(grants: ScopeGrant[], now = () => NOW) {
    const lines: string[] = [];
    const kv = memKv();
    for (const g of grants) addGrant(kv, 'hunt', g, g.issuedAt, g.id);
    const list = () => grantsOf(kv, 'hunt').map((g, i) => ({ ...g, expiresAt: grants[i].expiresAt }));
    // every host dials the local listener, so a granted "app.acme.com" never leaves the box
    const gw = new EgressGateway({ scope: async () => ok, grants: list, count: (id) => void countUse(kv, 'hunt', id), log: (l) => void lines.push(l), now, dial: (_h, port) => connect({ host: '127.0.0.1', port: port === 443 ? tlsPort : upPort }) });
    return { gw, lines, kv };
  }

  function get(gw: EgressGateway, url: string, auth = true): Promise<{ status: number; body: string }> {
    const p = new URL(gw.url);
    return new Promise((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port: Number(p.port), path: url, method: 'GET', headers: auth ? { 'proxy-authorization': `Basic ${Buffer.from(`${p.username}:${p.password}`).toString('base64')}` } : {} }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      r.on('error', reject);
      r.end();
    });
  }

  function tunnel(gw: EgressGateway, target: string): Promise<string> {
    const p = new URL(gw.url);
    return new Promise((resolve) => {
      const s = connect(Number(p.port), '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${Buffer.from(`${p.username}:${p.password}`).toString('base64')}\r\n\r\n`));
      let buf = '';
      s.on('data', (d) => {
        buf += d;
        if (buf.startsWith('HTTP/1.1 200') && buf.endsWith('\r\n\r\n')) s.write('ping');
        if (buf.includes('echo:ping') || buf.startsWith('HTTP/1.1 4')) {
          s.destroy();
          resolve(buf);
        }
      });
      s.on('close', () => resolve(buf));
    });
  }

  const grant = (over: Partial<ScopeGrant> = {}): ScopeGrant => ({ id: 'g1', hosts: ['app.acme.com'], accounts: [], requestBudget: 3, used: 0, rateRps: 100, issuedAt: NOW - 1000, expiresAt: NOW + 3_600_000, scope, ...over });

  test('lab reachable; in-scope without a grant refused at the gateway; wrong credentials refused', async () => {
    const { gw, lines } = setup([]);
    await gw.start();
    try {
      const lab = await get(gw, `http://127.0.0.1:${upPort}/x`);
      expect(lab).toEqual({ status: 200, body: 'hello from upstream' });
      expect(hits.at(-1)).toMatch(/clean$/);
      const live = await get(gw, 'http://app.acme.com/api/me');
      expect(live.status).toBe(403);
      expect(live.body).toMatch(/no approval grant/);
      expect((await get(gw, `http://127.0.0.1:${upPort}/x`, false)).status).toBe(407);
      expect(await tunnel(gw, 'app.acme.com:443')).toMatch(/^HTTP\/1.1 403/);
      expect(lines.some((l) => / PASS lab GET 127\.0\.0\.1:\d+\/x$/.test(l))).toBe(true);
      expect(lines.some((l) => /REFUSE 403 - GET app\.acme\.com:80\/api\/me/.test(l))).toBe(true);
    } finally {
      gw.stop();
    }
  });

  test('a grant lets requests through and counts them; the budget cuts off', async () => {
    const { gw, kv } = setup([grant()]);
    await gw.start();
    try {
      expect((await get(gw, 'http://app.acme.com/api/a')).status).toBe(200);
      expect(await tunnel(gw, 'app.acme.com:443')).toContain('echo:ping');
      expect((await get(gw, 'http://app.acme.com/api/c')).status).toBe(200);
      expect(grantsOf(kv, 'hunt')[0].used).toBe(3);
      const over = await get(gw, 'http://app.acme.com/api/d');
      expect(over.status).toBe(403);
      expect(over.body).toMatch(/budget of 3/);
    } finally {
      gw.stop();
    }
  });

  test('the rate cuts off with 429 and refills over time', async () => {
    let now = NOW;
    const { gw } = setup([grant({ rateRps: 1, requestBudget: 50 })], () => now);
    await gw.start();
    try {
      expect((await get(gw, 'http://app.acme.com/api/1')).status).toBe(200);
      expect((await get(gw, 'http://app.acme.com/api/2')).status).toBe(429);
      now += 1_000;
      expect((await get(gw, 'http://app.acme.com/api/3')).status).toBe(200);
    } finally {
      gw.stop();
    }
  });

  test('the Host header cannot name another vhost, and an %-encoded out-of-scope path is still out', async () => {
    const out = parseScope('program: acme\nin_scope: ["app.acme.com"]\nout_of_scope: ["/billing/**"]\n');
    const { gw } = setup([grant({ scope: out, requestBudget: 50 })]);
    await gw.start();
    const p = new URL(gw.url);
    try {
      const auth = `Basic ${Buffer.from(`${p.username}:${p.password}`).toString('base64')}`;
      const status = await new Promise<number>((resolve, reject) => {
        const r = request({ host: '127.0.0.1', port: Number(p.port), path: 'http://app.acme.com/api/x', headers: { 'proxy-authorization': auth, host: 'admin.acme.com' } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        r.on('error', reject);
        r.end();
      });
      expect(status).toBe(200);
      expect(hits.at(-1)).toMatch(/^app\.acme\.com \/api\/x /);
      expect((await get(gw, 'http://app.acme.com/bil%6cing/x')).status).toBe(403);
      expect((await get(gw, 'http://app.acme.com/a%2f..%2fbilling/x')).status).toBe(403);
      expect((await get(gw, 'http://app.acme.com/%zz')).status).toBe(400);
    } finally {
      gw.stop();
    }
  });

  test('an open tunnel is closed once its grant is revoked or expires', async () => {
    let now = NOW;
    for (const end of ['revoke', 'expire'] as const) {
      const { gw, kv } = setup([grant({ requestBudget: 50 })], () => now);
      await gw.start();
      try {
        const p = new URL(gw.url);
        const s = connect(Number(p.port), '127.0.0.1');
        let buf = '';
        s.on('data', (d) => (buf += d));
        const closed = new Promise<void>((r) => s.on('close', () => r()));
        s.write(`CONNECT app.acme.com:443 HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from(`${p.username}:${p.password}`).toString('base64')}\r\n\r\n`);
        while (!buf.includes('200 Connection')) await new Promise((r) => setTimeout(r, 10));
        await new Promise((r) => setTimeout(r, 20));
        gw.sweep();
        expect(s.destroyed).toBe(false);
        if (end === 'revoke') revokeGrant(kv, 'hunt', 'g1', now);
        else now = NOW + 3_600_000;
        gw.sweep();
        await closed;
      } finally {
        gw.stop();
        now = NOW;
      }
    }
  });

  test('an expired grant is refused', async () => {
    const { gw } = setup([grant({ expiresAt: NOW - 1 })]);
    await gw.start();
    try {
      const r = await get(gw, 'http://app.acme.com/api/me');
      expect(r.status).toBe(403);
      expect(r.body).toMatch(/expired/);
    } finally {
      gw.stop();
    }
  });
});

describe('around the gateway', () => {
  const live: ScopeGrant = { id: 'g1', hosts: ['app.acme.com'], accounts: [], requestBudget: 50, used: 0, rateRps: 2, issuedAt: NOW - 1000, expiresAt: NOW + 3_600_000, scope };
  const bash = (command: string) => decide({ tool: 'Bash', input: { command }, scope: ok, grants: [live], member: false, now: NOW });

  test('a command that turns the proxy off asks even with a live grant; lab-only and plain commands pass', () => {
    expect(bash('curl -sS https://app.acme.com/api/me')).toBeUndefined();
    for (const cmd of [
      'curl --noproxy "*" https://app.acme.com/api/me',
      "curl -x '' https://app.acme.com/api/me",
      'env -u HTTPS_PROXY curl https://app.acme.com/api/me',
      'unset HTTPS_PROXY https_proxy; curl https://app.acme.com/api/me',
      'NO_PROXY=app.acme.com curl https://app.acme.com/api/me',
      'unset ALL_PROXY HTTP_PROXY HTTPS_PROXY; python3 poc.py',
      'env -i python3 poc.py',
    ]) {
      expect(bash(cmd)).toMatchObject({ decision: 'ask', reason: expect.stringContaining('egress gateway') });
    }
    expect(bash('curl --noproxy "*" http://127.0.0.1:8080/')).toBeUndefined();
    expect(bash('curl --noproxy "*" https://admin.acme.com/')).toMatchObject({ decision: 'deny' });
  });

  test("a member's hunt shell still goes through a gateway, and it passes no live host even with a grant in kv", async () => {
    const d = tempDir('conclave-egress-');
    writeFileSync(join(d, 'scope.yaml'), 'program: acme\nin_scope: ["app.acme.com"]\nlab: ["sec-lab-acme"]\n');
    mkdirSync(join(d, 'findings'), { recursive: true });
    const kv = memKv();
    addGrant(kv, 'hunt', { hosts: ['app.acme.com'], accounts: [], requestBudget: 50, used: 0, rateRps: 5 }, Date.now(), 'g1');
    const session = { id: 'hunt', agent: 'sec-lead', cwd: d, device: 'local' } as unknown as Session;
    const m = new FakeMachine();
    const host: EgressHost = {
      getSession: (id) => (id === 'hunt' ? session : undefined),
      agentFor: () => ({ name: 'sec-lead', description: '', prompt: '', recipes: ['scope-guard'] }) as AgentDef,
      machineFor: () => m,
      isMemberSession: () => true,
      repos: { kv },
    };
    try {
      const env = await egressEnv(host, session);
      expect(env?.HTTPS_PROXY).toMatch(/^http:\/\/conclave:.+@127\.0\.0\.1:\d+$/);
      const p = new URL(env!.HTTP_PROXY);
      const status = await new Promise<number>((resolve, reject) => {
        // refused before any dial, so nothing leaves the box
        const r = request({ host: '127.0.0.1', port: Number(p.port), path: 'http://app.acme.com/', headers: { 'proxy-authorization': `Basic ${Buffer.from(`${p.username}:${p.password}`).toString('base64')}` } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        r.on('error', reject);
        r.end();
      });
      expect(status).toBe(403);
    } finally {
      await stopEgress(host);
      cleanup(d);
    }
  });
});
