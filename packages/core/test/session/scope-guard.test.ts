import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, FakeMachine, tempDir } from '../extensions/_helpers';
import { Hooks } from '../../src/extensions/hooks';
import { GRANTS_KV, GRANT_MAX_MS, ScopeError, classify, decide, grantLive, parseScope, targetsInCommand, type GuardCall, type ScopeGrant, type ScopeState } from '../../src/security/scope';
import { attachScopeGuard, guardAnchor, loadScope, scopeGuardCheck, type ScopeGuardHost } from '../../src/session/scope-guard';
import type { AgentDef, HookInput } from '../../src/extensions/types';
import type { Session } from '../../src/types';

/**
 * Security mode PR 1 (docs/design/SECURITY-MODE.md section 6): the scope.yaml
 * parser and the scope guard. Each test is one row of the PR 1 test list or
 * of the 4.4 table.
 */

const dirs: string[] = [];
afterAll(() => cleanup(...dirs));

const SCOPE = `
program: acme
venue: hackerone
in_scope: ["app.acme.com", "*.api.acme.com"]
paths: ["/api/**", "/login"]
out_of_scope: ["admin.acme.com", "/billing/**"]
lab: ["sec-lab-acme"]
callback: ["cb.example.net"]
rate_limit_rps: 2
request_budget: 300
accounts: ["attacker", "victim"]
no: ["dos", "social"]
expires: 2099-01-01
`;
const scope = parseScope(SCOPE);
const ok: ScopeState = { kind: 'ok', scopes: [scope], files: ['/hunt/scope.yaml'] };
const NOW = Date.UTC(2026, 10, 5, 12);
const grant = (over: Partial<ScopeGrant> = {}): ScopeGrant => ({ id: 'g1', hosts: ['app.acme.com'], accounts: ['attacker'], requestBudget: 500, rateRps: 1, issuedAt: NOW - 3_600_000, expiresAt: NOW + 3_600_000, ...over });
const run = (tool: string, input: Record<string, unknown>, over: Partial<GuardCall> = {}) => decide({ tool, input, scope: ok, grants: [], member: false, now: NOW, ...over });
const curl = (url: string) => ({ command: `curl -sS ${url}` });

describe('scope.yaml parser', () => {
  test('reads every field of the design schema', () => {
    expect(scope).toEqual({
      program: 'acme',
      venue: 'hackerone',
      inScope: ['app.acme.com', '*.api.acme.com'],
      paths: ['/api/**', '/login'],
      outOfScope: ['admin.acme.com', '/billing/**'],
      lab: ['sec-lab-acme'],
      callback: ['cb.example.net'],
      rateLimitRps: 2,
      requestBudget: 300,
      accounts: ['attacker', 'victim'],
      no: ['dos', 'social'],
      expires: '2099-01-01',
    });
  });

  test('lab is named networks only: IPs and ranges are refused', () => {
    expect(() => parseScope('program: x\nin_scope: [a.com]\nlab: ["10.0.0.0/8"]')).toThrow(/never IPs or ranges/);
    expect(() => parseScope('program: x\nin_scope: [a.com]\nlab: ["10.0.0.5"]')).toThrow(ScopeError);
    expect(() => parseScope('program: x\nin_scope: ["192.168.1.0/24"]')).toThrow(/IP range/);
  });

  test('missing or wrong fields say which', () => {
    expect(() => parseScope('in_scope: [a.com]')).toThrow(/program/);
    expect(() => parseScope('program: x')).toThrow(/in_scope/);
    expect(() => parseScope('program: x\nin_scope: [a.com]\nvenue: reddit')).toThrow(/venue/);
    expect(() => parseScope('program: x\nin_scope: [a.com]\nrate_limit_rps: 0')).toThrow(/rate_limit_rps/);
    expect(() => parseScope(': : :')).toThrow(ScopeError);
  });

  test('the request budget is capped at 500 (owner decision on #271)', () => {
    expect(parseScope('program: x\nin_scope: [a.com]\nrequest_budget: 9000').requestBudget).toBe(500);
  });
});

describe('host classes', () => {
  test('globs, paths, out-of-scope paths on any host, ports and users', () => {
    expect(classify(scope, 'v2.api.acme.com', '/api/users')).toBe('in');
    expect(classify(scope, 'APP.acme.com:8443', '/login')).toBe('in');
    expect(classify(scope, 'app.acme.com', '/static/x.js')).toBe('in-bad-path');
    expect(classify(scope, 'app.acme.com', '/billing/1')).toBe('out');
    expect(classify(scope, 'admin.acme.com')).toBe('out');
    expect(classify(scope, 'web.sec-lab-acme')).toBe('lab');
    expect(classify(scope, 'localhost')).toBe('lab');
    expect(classify(scope, 'acme.com')).toBe('unknown');
  });

  test('a private IP like 10.0.0.5 is not lab unless named', () => {
    expect(classify(scope, '10.0.0.5')).toBe('unknown');
    expect(run('Bash', curl('http://10.0.0.5/'))).toMatchObject({ decision: 'ask' });
  });
});

describe('the PR 1 test list', () => {
  test('in-scope without a grant asks', () => {
    expect(run('Bash', curl('https://app.acme.com/api/me'))).toMatchObject({ decision: 'ask', reason: expect.stringContaining('no live approval grant') });
  });

  test('in-scope with a valid grant passes', () => {
    expect(run('Bash', curl('https://app.acme.com/api/me'), { grants: [grant()] })).toBeUndefined();
  });

  test('expired, revoked, spent or oversize grants do not count', () => {
    for (const g of [grant({ expiresAt: NOW - 1 }), grant({ revokedAt: NOW - 1 }), grant({ used: 500 }), grant({ requestBudget: 501 }), grant({ issuedAt: NOW - GRANT_MAX_MS - 2, expiresAt: NOW + 1 }), grant({ hosts: ['other.acme.com'] })]) {
      expect(grantLive(g, NOW) && g.hosts.includes('app.acme.com')).toBe(false);
      expect(run('Bash', curl('https://app.acme.com/api/me'), { grants: [g] })).toMatchObject({ decision: 'ask' });
    }
  });

  test('WebFetch to an in-scope live host is denied, grant or not', () => {
    expect(run('WebFetch', { url: 'https://app.acme.com/api/me', prompt: 'x' }, { grants: [grant()] })).toMatchObject({ decision: 'deny', reason: expect.stringContaining('validator') });
  });

  test('WebFetch to an unlisted host is research and passes', () => {
    expect(run('WebFetch', { url: 'https://docs.python.org/3/', prompt: 'x' })).toBeUndefined();
  });

  test('out-of-scope is denied, grant or not', () => {
    expect(run('Bash', curl('https://admin.acme.com/'), { grants: [grant({ hosts: ['*.acme.com'] })] })).toMatchObject({ decision: 'deny' });
    expect(run('browser_navigate', { url: 'https://app.acme.com/billing/2' })).toMatchObject({ decision: 'deny' });
  });

  test('an unknown host asks', () => {
    expect(run('Bash', curl('https://evil.example.org/'))).toMatchObject({ decision: 'ask', reason: expect.stringContaining('not listed') });
  });

  test('a lab network passes', () => {
    expect(run('Bash', curl('http://web.sec-lab-acme:8080/api'))).toBeUndefined();
    expect(run('mcp__caido__caido_send_request', { host: 'web.sec-lab-acme', port: 80, raw: 'GET / HTTP/1.1\r\nHost: web.sec-lab-acme\r\n\r\n' })).toBeUndefined();
  });

  test('no scope file asks', () => {
    expect(run('Bash', curl('https://app.acme.com/'), { scope: { kind: 'none' } })).toMatchObject({ decision: 'ask', reason: expect.stringContaining('no scope.yaml') });
    expect(run('WebFetch', { url: 'https://docs.python.org/' }, { scope: { kind: 'bad', why: 'expired' } })).toMatchObject({ decision: 'ask' });
  });

  test('caido race_window_send is denied unless every host is lab', () => {
    const race = 'mcp__caido__caido_race_window_send';
    expect(run(race, { host: 'app.acme.com', port: 443, requests: [] }, { grants: [grant()] })).toMatchObject({ decision: 'deny' });
    expect(run(race, { requests: [] })).toMatchObject({ decision: 'deny' });
    expect(run(race, { host: 'web.sec-lab-acme', port: 80 })).toBeUndefined();
  });
});

describe('every network-capable tool', () => {
  test('Bash: wget, nc, nmap host arguments, python requests and raw IPs', () => {
    expect(run('Bash', { command: 'wget -O out.html app.acme.com/api/x' })).toMatchObject({ decision: 'ask' });
    expect(run('Bash', { command: 'nc -v admin.acme.com 443' })).toMatchObject({ decision: 'deny' });
    expect(run('Bash', { command: 'nmap -p 80 admin.acme.com' })).toMatchObject({ decision: 'deny' });
    expect(run('Bash', { command: `python3 -c "import requests; requests.get('https://admin.acme.com/')"` })).toMatchObject({ decision: 'deny' });
    expect(run('Bash', { command: `python3 -c "import socket; socket.create_connection(('admin.acme.com', 443))"` })).toMatchObject({ decision: 'deny' });
    expect(run('Bash', { command: 'ssh root@10.0.0.5' })).toMatchObject({ decision: 'ask' });
  });

  test('Bash with no host and file names after flags pass', () => {
    expect(run('Bash', { command: 'ls -la && git status' })).toBeUndefined();
    expect(targetsInCommand('curl -o out.json -H "X-Test: 1" http://web.sec-lab-acme/').map((t) => t.host)).toEqual(['web.sec-lab-acme']);
  });

  test('browser tools and any MCP tool with a URL', () => {
    expect(run('browser_navigate', { url: 'https://app.acme.com/login' })).toMatchObject({ decision: 'ask' });
    expect(run('mcp__fetch__fetch', { url: 'https://admin.acme.com/' })).toMatchObject({ decision: 'deny' });
  });

  test('Caido send, batch and replay read the host field and the raw Host header', () => {
    expect(run('mcp__caido__caido_send_request', { raw: 'POST /api/x HTTP/1.1\r\nHost: app.acme.com\r\n\r\n' })).toMatchObject({ decision: 'ask' });
    expect(run('mcp__caido__caido_batch_send', { requests: [{ host: 'admin.acme.com' }] })).toMatchObject({ decision: 'deny' });
    // a replay by session id has no host the guard can read
    expect(run('mcp__caido__caido_send_replay', { session_id: '12' })).toMatchObject({ decision: 'ask' });
    expect(run('mcp__caido__caido_list_replay_collections', {})).toBeUndefined();
  });

  test('Delegate carrying a network task to another device', () => {
    expect(run('Delegate', { to: 'code', device: 'arch-desktop', prompt: 'Run curl https://admin.acme.com/ and report.' })).toMatchObject({ decision: 'deny' });
    expect(run('Delegate', { to: 'code', device: 'arch-desktop', prompt: 'Probe app.acme.com for IDOR with the attacker account.' })).toMatchObject({ decision: 'ask' });
    expect(run('Delegate', { to: 'code', prompt: 'Scan 10.0.0.5 for open ports.' })).toMatchObject({ decision: 'ask' });
    expect(run('Delegate', { to: 'code', prompt: 'Summarize the notes in README.md.' })).toBeUndefined();
  });

  test('a member never gets a live target, even with a grant', () => {
    expect(run('Bash', curl('https://app.acme.com/api/me'), { member: true, grants: [grant()] })).toMatchObject({ decision: 'deny', reason: expect.stringContaining('lab-only') });
    expect(run('Bash', curl('http://web.sec-lab-acme/'), { member: true })).toBeUndefined();
  });

  test('tools that cannot reach the network are left alone', () => {
    expect(run('Read', { file_path: 'https://admin.acme.com/' })).toBeUndefined();
  });
});

describe('review: bypasses and hostile scope files', () => {
  test('a lab entry is a sec-lab-<t> network with no dots, so it cannot name a public suffix', () => {
    for (const n of ['com', 'acme.com', 'sec-lab-a.com', 'lab1']) expect(() => parseScope(`program: x\nin_scope: [a.com]\nlab: ["${n}"]`)).toThrow(/sec-lab-/);
  });

  test("a member's scope file cannot widen lab-only: lab: [com] makes the file unusable, so live hosts are not lab", async () => {
    const st = await loadScope(new FakeMachine(), hunt('program: m\nin_scope: [app.acme.com]\nlab: ["com"]'));
    expect(st.kind).toBe('bad');
    expect(run('Bash', curl('https://app.acme.com/api/me'), { member: true, scope: st })).toMatchObject({ decision: 'ask' });
  });

  test('one host spelled another way matches: trailing dots, punycode and unicode, numeric IPv4', () => {
    expect(run('WebFetch', { url: 'https://app.acme.com../api/x' })).toMatchObject({ decision: 'deny' });
    const idn: ScopeState = { kind: 'ok', scopes: [parseScope('program: i\nin_scope: ["bücher.de", "1.2.3.4"]\nout_of_scope: ["*.xn--mnchen-3ya.de"]')], files: [] };
    expect(run('WebFetch', { url: 'https://xn--bcher-kva.de/' }, { scope: idn })).toMatchObject({ decision: 'deny' });
    expect(run('Bash', curl('https://shop.münchen.de/'), { scope: idn })).toMatchObject({ decision: 'deny' });
    expect(run('WebFetch', { url: 'http://0x01020304/' }, { scope: idn })).toMatchObject({ decision: 'deny' });
    expect(run('WebFetch', { url: 'http://16909060/' }, { scope: idn })).toMatchObject({ decision: 'deny' });
  });

  test('curl reads "lab\\@live" as user lab\\ at host live: the live host counts', () => {
    expect(run('Bash', { command: 'curl "http://web.sec-lab-acme\\@admin.acme.com/"' })).toMatchObject({ decision: 'deny' });
  });

  test('Bash: /dev/tcp, socat, rsync and a host in a variable', () => {
    expect(run('Bash', { command: 'exec 3<>/dev/tcp/admin.acme.com/443' })).toMatchObject({ decision: 'deny' });
    expect(run('Bash', { command: 'echo x > /dev/tcp/evil.example.org/80' })).toMatchObject({ decision: 'ask' });
    expect(run('Bash', { command: 'socat - TCP:app.acme.com:80' })).toMatchObject({ decision: 'ask' });
    expect(run('Bash', { command: 'socat - OPENSSL:evil.example.org:443' })).toMatchObject({ decision: 'ask' });
    expect(run('Bash', { command: 'rsync -a x app.acme.com:/tmp' })).toMatchObject({ decision: 'ask' });
    expect(run('Bash', { command: 'H=admin.acme.com; curl $H' })).toMatchObject({ decision: 'deny' });
    expect(run('Bash', { command: 'env H=admin.acme.com sh -c "curl $H"' })).toMatchObject({ decision: 'deny' });
  });

  test('MCP: host lists, server and ip fields, deep nesting, Caido under another server name', () => {
    expect(run('mcp__x__scan', { hosts: ['web.sec-lab-acme', 'admin.acme.com'] })).toMatchObject({ decision: 'deny' });
    expect(run('mcp__x__scan', { server: 'admin.acme.com' })).toMatchObject({ decision: 'deny' });
    expect(run('mcp__x__scan', { ip: '10.0.0.5' })).toMatchObject({ decision: 'ask' });
    expect(run('mcp__x__deep', { a: { b: { c: { d: { e: { f: { g: { url: 'https://admin.acme.com/' } } } } } } } })).toMatchObject({ decision: 'deny' });
    expect(run('mcp__caido-proxy__caido_race_window_send', { host: 'app.acme.com' }, { grants: [grant()] })).toMatchObject({ decision: 'deny' });
    expect(run('mcp__caido-proxy__caido_send_replay', { session_id: '1' })).toMatchObject({ decision: 'ask' });
  });

  test('other hub fetchers are WebFetch: Capture, ReadPost and SaveInspiration to an in-scope host are denied', () => {
    for (const tool of ['Capture', 'ReadPost', 'SaveInspiration']) {
      expect(run(tool, { url: 'https://app.acme.com/api/x' }, { grants: [grant()] })).toMatchObject({ decision: 'deny' });
      expect(run(tool, { url: 'https://docs.python.org/' })).toBeUndefined();
    }
  });

  test('a routine or a watch runs later outside the guard: an in-scope host is denied, grant or not', () => {
    expect(run('ScheduleRoutine', { name: 'x', schedule: '@every 1h', prompt: 'curl https://app.acme.com/api/me' }, { grants: [grant()] })).toMatchObject({ decision: 'deny' });
    expect(run('ScheduleRoutine', { name: 'x', schedule: '@every 1h', prompt: 'Probe app.acme.com again.' })).toMatchObject({ decision: 'deny' });
    expect(run('WatchCreate', { name: 'x', schedule: '@every 1h', url: 'https://app.acme.com/api/list', prompt: 'x' })).toMatchObject({ decision: 'deny' });
    expect(run('ScheduleRoutine', { name: 'x', schedule: '@every 1h', prompt: 'Summarize my notes.' })).toBeUndefined();
  });

  test('browser page code: a listed host without a scheme counts', () => {
    expect(run('browser_evaluate', { function: "() => fetch('//admin.acme.com/')" })).toMatchObject({ decision: 'deny' });
    expect(run('browser_run_code_unsafe', { code: "await page.goto('https://' + 'app.acme.com')" })).toMatchObject({ decision: 'ask' });
  });

  test('changing a scope file asks; reading it or writing other files does not', () => {
    expect(run('Write', { file_path: '/hunt/targets/a/scope.yaml', content: 'lab: [x]' })).toMatchObject({ decision: 'ask', reason: expect.stringContaining('scope.yaml') });
    expect(run('Edit', { file_path: '/hunt/scope.yaml', old_string: 'a', new_string: 'b' })).toMatchObject({ decision: 'ask' });
    expect(run('Bash', { command: "sed -i 's/admin/x/' scope.yaml" })).toMatchObject({ decision: 'ask' });
    expect(run('Bash', { command: 'echo "in_scope: [x]" >> targets/a/scope.yaml' })).toMatchObject({ decision: 'ask' });
    expect(run('Bash', { command: 'cat scope.yaml' })).toBeUndefined();
    expect(run('Write', { file_path: '/hunt/notes.md', content: 'https://admin.acme.com/' })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Wiring: files on the session's device, grants in kv, the session chain
// ---------------------------------------------------------------------------

function hunt(text = SCOPE): string {
  const d = tempDir('conclave-hunt-');
  dirs.push(d);
  writeFileSync(join(d, 'scope.yaml'), text);
  return d;
}

function host(sessions: Session[], agents: Record<string, AgentDef>, kv: Record<string, unknown> = {}, member = false): ScopeGuardHost {
  const m = new FakeMachine();
  return {
    getSession: (id) => sessions.find((s) => s.id === id),
    agentFor: (s) => agents[s.agent] ?? ({ name: s.agent, description: '', prompt: '' } as AgentDef),
    machineFor: () => m,
    isMemberSession: () => member,
    repos: { kv: { get: <T>(k: string, f: T) => (kv[k] as T) ?? f } },
  };
}

const AGENTS: Record<string, AgentDef> = { 'sec-lead': { name: 'sec-lead', description: '', prompt: '', recipes: ['scope-guard'] } as AgentDef };
const sess = (id: string, agent: string, cwd: string, parentId?: string) => ({ id, agent, cwd, ...(parentId ? { parentId } : {}) }) as unknown as Session;
const pre = (session: string, tool: string, tool_input: Record<string, unknown>): HookInput => ({ session_id: session, cwd: '/', hook_event_name: 'PreToolUse', tool_name: tool, tool_input });

describe('scope guard wiring', () => {
  test('reads scope.yaml and targets/<t>/scope.yaml on the device; a bad or expired file is bad', async () => {
    const d = hunt();
    mkdirSync(join(d, 'targets', 'b'), { recursive: true });
    writeFileSync(join(d, 'targets', 'b', 'scope.yaml'), 'program: b\nin_scope: [b.example.com]\n');
    const st = await loadScope(new FakeMachine(), d);
    expect(st.kind === 'ok' && st.scopes.map((s) => s.program)).toEqual(['acme', 'b']);
    expect((await loadScope(new FakeMachine(), hunt('program: x\nin_scope: [a.com]\nexpires: 2020-01-01'))).kind).toBe('bad');
    expect((await loadScope(new FakeMachine(), hunt('program: x\nlab: ["10.0.0.0/8"]\nin_scope: [a.com]'))).kind).toBe('bad');
  });

  test('off for sessions whose chain has no scope-guard agent', async () => {
    const d = hunt();
    const h = host([sess('s1', 'coder', d)], AGENTS);
    expect(await scopeGuardCheck(h, pre('s1', 'Bash', curl('https://admin.acme.com/')))).toBeUndefined();
  });

  test('a Task child or Delegate session of a security session is guarded with the parent\'s scope and grants', async () => {
    const d = hunt();
    const other = tempDir('conclave-elsewhere-');
    dirs.push(other);
    const sessions = [sess('lead', 'sec-lead', d), sess('child', 'explore', other, 'lead')];
    const h = host(sessions, AGENTS, { [GRANTS_KV]: { lead: [{ ...grant(), issuedAt: Date.now() - 1_000, expiresAt: Date.now() + 3_600_000 }] } });
    expect(guardAnchor(h, sessions[1])?.id).toBe('lead');
    expect(await scopeGuardCheck(h, pre('child', 'Bash', curl('https://admin.acme.com/')))).toMatchObject({ blocked: true, permissionDecision: 'deny' });
    expect(await scopeGuardCheck(h, pre('child', 'Bash', curl('https://app.acme.com/api/me')))).toBeUndefined();
    expect(await scopeGuardCheck(h, pre('child', 'Bash', curl('https://v1.api.acme.com/api/me')))).toMatchObject({ permissionDecision: 'ask' });
  });

  test('no scope file in the hunt folder asks', async () => {
    const d = tempDir('conclave-hunt-empty-');
    dirs.push(d);
    const h = host([sess('lead', 'sec-lead', d)], AGENTS);
    expect(await scopeGuardCheck(h, pre('lead', 'WebFetch', { url: 'https://docs.python.org/' }))).toMatchObject({ permissionDecision: 'ask' });
  });

  test('registered on the hook runner, a deny blocks the call', async () => {
    const d = hunt();
    const hooks = new Hooks({});
    attachScopeGuard(host([sess('lead', 'sec-lead', d)], AGENTS), hooks);
    const o = await hooks.run('PreToolUse', pre('lead', 'WebFetch', { url: 'https://app.acme.com/api/me' }), { matcherValue: 'WebFetch', hooks: {} });
    expect(o.blocked).toBe(true);
    expect(o.permissionDecision).toBe('deny');
    expect(o.trace?.[0]).toMatchObject({ label: 'scope-guard', result: 'deny' });
  });
});
