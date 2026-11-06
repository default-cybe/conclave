/**
 * The security-hunt library workflow against scripted sec-* agents (no paid
 * calls, no traffic: the "live" host is a name in scope.yaml that nothing
 * sends to). Design PR 6 (docs/design/SECURITY-MODE.md 3.1, 3.2):
 * - an agreeing refuter without a passing step 7 never yields confirmed;
 * - no grant parks the lead as partial, and the run goes on;
 * - one grant covers two leads on the same target;
 * - a source lead that only the live host can prove switches to web, logged;
 * - roles go by agentType, never a model; memory read first, written last.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstUserText, startTestEngine, type RequestBody, type Step, type TestEngine } from '../engine/harness';
import { afterToolResult, svcOf, noHarnesses } from './helpers';
import { tempDir } from '../extensions/_helpers';
import { DEFAULT_WORKFLOWS } from '../../src/workflows/defaults';
import { GRANTS_KV, type ScopeGrant } from '../../src/security/scope';

let t: TestEngine;
let answers: Array<[string, (body: RequestBody) => Step | number | undefined]> = [];
const so = (input: Record<string, unknown>) => (body: RequestBody): Step => (afterToolResult(body) ? [{ text: 'done' }] : [{ tool: 'StructuredOutput', input }]);
const done = (): Step => [{ text: 'done' }];

beforeAll(async () => {
  t = await startTestEngine({
    script: [[{ text: 'fallback' }]],
    route: (body) => {
      const first = firstUserText(body);
      for (const [word, fn] of answers) if (first.includes(word)) return fn(body);
      return undefined;
    },
    approve: 'allow',
    overrides: { limits: { maxRetries: 0 } } as never,
  });
  noHarnesses(t.engine);
});
afterAll(async () => t?.close());

const SCOPE = `program: acme
venue: hackerone
in_scope: ["app.acme.example"]
out_of_scope: ["admin.acme.example"]
lab: ["sec-lab-acme"]
rate_limit_rps: 1
request_budget: 40
accounts: ["tenantA (test)", "tenantB (test)"]
no: [dos]
expires: 2099-12-31
`;

function huntFolder(scope = SCOPE) {
  const dir = tempDir('conclave-wf-sechunt-');
  mkdirSync(join(dir, 'targets', 'acme', 'src'), { recursive: true });
  mkdirSync(join(dir, 'findings', 'acme-hunt'), { recursive: true });
  if (scope) writeFileSync(join(dir, 'targets', 'acme', 'scope.yaml'), scope);
  writeFileSync(join(dir, 'targets', 'acme', 'src', 'invoices.ts'), ['export function get(req) {', '  return db.invoice(req.params.id)', '}', 'export function memo(req) {', '  return db.setMemo(req.params.id, req.body.memo)', '}'].join('\n') + '\n');
  return dir;
}

const LEAD1 = { file: 'targets/acme/src/invoices.ts', line: 2, quote: '  return db.invoice(req.params.id)', title: 'Any viewer reads another tenant invoice', class: 'read-authz', invariant: 'An invoice belongs to one tenant', proofPlan: 'tenantA reads a seeded tenantB invoice', priority: 'P1' };
const LEAD2 = { file: 'targets/acme/src/invoices.ts', line: 5, quote: '  return db.setMemo(req.params.id, req.body.memo)', title: 'Any viewer rewrites another tenant memo', class: 'write-authz', invariant: 'Only the owner tenant writes a memo', proofPlan: 'tenantA patches tenantB memo', priority: 'P1' };
const HOLDS = { verdict: 'confirmed', lenses: [{ lens: 'Reachability', vote: 'holds', reason: 'a viewer calls it' }, { lens: 'Boundary rule', vote: 'holds', reason: 'docs say one tenant' }, { lens: 'Downstream check', vote: 'holds', reason: 'no later filter' }], assumptions: [{ text: 'Invoice ids are guessable.', tested: true, how: 'ran: seq ids 7730, 7731' }, { text: 'The live app runs the lab version.', tested: false, how: 'needs the live host' }], note: 'holds on all three lenses' };
const PASS = [1, 2, 3].map((i) => ({ label: `Run ${i} of 3`, detail: 'tenantA got the tenantB canary, 200', pass: true }));
const CONTROLS = [{ label: 'Own object', detail: 'tenantA reads its own, 200', pass: true }, { label: 'Forbidden sibling', detail: '/members 403', pass: true }];

/** Scripted roles. validate(lead title, marker, prompt) answers for the validator and may write RESULT.txt like the real one. */
function roles(dir: string, leads: Array<Record<string, unknown>>, validate: (title: string, marker: string) => Record<string, unknown> | null) {
  let hunts = 0;
  answers = [
    ['Load the hunt memory', so({ known: [], parked: [], notes: 'two tenants' })],
    ['Map the attack surface', so({ guardIdiom: 'requireTenant(req)', roles: ['viewer', 'admin'], carriers: ['invoice memo'], summary: '2 routes skip requireTenant' })],
    // round 1, route 1 finds the leads; every other call finds nothing new
    ['Hunt for leads', (body) => (afterToolResult(body) ? done() : so({ leads: hunts++ === 0 ? leads : [] })(body))],
    ['Refute this lead', so(HOLDS)],
    [
      'Run the lane oracle',
      (body) => {
        if (afterToolResult(body)) return done();
        const p = firstUserText(body);
        const marker = /CANARY-[a-z0-9]+/i.exec(p)?.[0] ?? '';
        const title = leads.find((l) => p.includes(String(l.title)))?.title as string;
        const v = validate(title, marker);
        return v ? so(v)(body) : [{ text: 'could not run it' }];
      },
    ],
    ['Answer the 7-Question Gate', so({ answers: Array.from({ length: 7 }, () => ({ yes: true, why: 'checked' })) })],
    ['Write back the hunt ledger', so({ appended: leads.length, catalogueDiff: '' })],
    ['Draft REPORT.md', done],
  ];
  return { result: (marker: string) => writeFileSync(join(dir, 'findings', 'acme-hunt', 'RESULT.txt'), `# run 1 of 3\nGET /api/v2/invoices/inv_b HTTP/1.1\n\n200 ${marker}\n`) };
}

async function hunt(dir: string, args: Record<string, unknown>, opts: { unattended?: boolean } = {}) {
  const svc = svcOf(t.engine);
  // a security session with Same model for all work: the pin, not a model in the script, puts every sec-* role on the mock
  const s = await t.engine.createSession({ cwd: dir, agent: 'security', chat: { sameModel: true } } as never);
  const run = await svc.wait((await svc.startRun({ name: 'security-hunt', sessionId: s.id, args: { target: 'acme', ...args } }, { unattended: opts.unattended })).id);
  const calls = svc.store.calls(run.id);
  const logs = svc.store.logs(run.id).map((l) => l.text);
  const notices = (t.engine.getMessages(s.id) as unknown as Array<{ kind: string; meta?: Record<string, unknown> }>).filter((m) => m.kind === 'notice' && m.meta?.type);
  return { run, calls, logs, notices, session: s, result: run.result as { leads: Array<{ n: number; status: string; reason: string; proofLane: string }>; laneChanges: unknown[]; grants: { asked: number; granted: string | null; denied: boolean }; stopped?: string; reason?: string } };
}

const grantsOf = (sessionId: string) => (t.engine.repos.kv.get<Record<string, ScopeGrant[]>>(GRANTS_KV, {})[sessionId] ?? []);

test('an agreeing refuter without a passing step 7 never yields confirmed; the oracle with its evidence does', async () => {
  const dir = huntFolder();
  const r = roles(dir, [LEAD1, LEAD2], (title, marker) => {
    // lead 1: every run "passes" by the agent's word, but no RESULT.txt with its marker exists
    if (title === LEAD1.title) return { reproduced: true, runs: PASS, controls: CONTROLS, evidence: 'trust me', result: 'findings/acme-hunt/NONE.txt' };
    r.result(marker);
    return { reproduced: true, runs: PASS, controls: CONTROLS.slice(0, 2), evidence: 'GET ... 200 ' + marker, result: 'findings/acme-hunt/RESULT.txt', on: 'sec-lab-acme' };
  });
  const before = t.requests.length;
  const h = await hunt(dir, { lane: 'source' });
  expect(h.run.error).toBeUndefined();
  expect(h.run.status).toBe('done');
  const byN = Object.fromEntries(h.result.leads.map((l) => [l.n, l]));
  // refuter agreed on both (3 of 3 lenses hold); only the lead whose oracle evidence checks out is confirmed
  expect(byN[1].status).toBe('partial');
  expect(byN[1].reason).toContain('could not be read');
  expect(byN[2].status).toBe('confirmed');
  // lab-only plans: no grant asked, no approval card
  expect(h.result.grants.asked).toBe(0);

  // the finding cards: evidence, votes and the untested assumption; confirmed only on lead 2
  const cards = h.notices.filter((m) => m.meta!.type === 'finding');
  expect(cards.map((c) => c.meta!.state)).toEqual(['partial', 'confirmed']);
  const card = cards[1].meta as { oracle: { runs: unknown[]; result: string }; refuter: { votes: unknown[]; assumptions: Array<{ tested: boolean }> } };
  expect(card.oracle.runs.length).toBe(5);
  expect(card.refuter.votes.length).toBe(3);
  expect(card.refuter.assumptions.filter((a) => !a.tested).length).toBe(1);

  // roles by agentType only, never a model ref; the hunt ran 3 routes per round until 2 dry rounds
  const agents = h.calls.filter((c) => c.kind === 'agent');
  expect(agents.every((c) => c.agentType?.startsWith('sec-'))).toBe(true);
  expect(agents.filter((c) => c.label?.startsWith('hunt r')).length).toBe(9);
  const script = DEFAULT_WORKFLOWS.find((d) => d.file === 'security-hunt.js')!.script;
  // no literal model ref and no tier in any agent() option
  expect(/\b(model|tier|models):\s*['"[]/.test(script)).toBe(false);
  // memory read first, written last: the ledger read and the load agent come before recon; record after every validation
  const seq = (p: (l: string) => boolean) => h.calls.filter((c) => c.label && p(c.label)).map((c) => c.seq);
  expect(Math.max(...seq((l) => l.startsWith('ledger: read')), ...seq((l) => l === 'load'))).toBeLessThan(Math.min(...seq((l) => l === 'recon')));
  expect(Math.min(...seq((l) => l === 'record'))).toBeGreaterThan(Math.max(...seq((l) => l.startsWith('validate lead') || l.startsWith('gate lead'))));
  expect(t.requests.slice(before).some((x) => x.includes('Draft REPORT.md'))).toBe(true);
  // the hub ledger has both, confirmed with its evidence
  const ledger = svcOf(t.engine).store.ledger(h.run.device, dir);
  expect(ledger.length).toBe(2);
  expect(ledger.find((e) => e.finding.startsWith(LEAD2.title))?.evidence).toBe('findings/acme-hunt/RESULT.txt');
});

test('a refuter that agrees and a validator that returns nothing: partial, never confirmed', async () => {
  const dir = huntFolder();
  roles(dir, [LEAD1], () => null);
  const h = await hunt(dir, { lane: 'source' });
  expect(h.run.status).toBe('done');
  expect(h.result.leads[0].status).toBe('partial');
  expect(h.notices.find((m) => m.meta!.type === 'finding')?.meta!.state).toBe('partial');
});

test('no grant parks the lead as partial; an unattended run goes on and stays lab-only', async () => {
  const dir = huntFolder();
  roles(dir, [LEAD1, LEAD2], () => {
    throw new Error('the validator must not run without a grant');
  });
  const h = await hunt(dir, { lane: 'web', url: 'https://app.acme.example' }, { unattended: true });
  expect(h.run.error).toBeUndefined();
  expect(h.run.status).toBe('done');
  expect(h.result.leads.map((l) => l.status)).toEqual(['partial', 'partial']);
  expect(h.result.leads.every((l) => l.reason === 'no approval grant for the live host')).toBe(true);
  expect(h.result.grants).toEqual({ asked: 1, granted: null, denied: true });
  expect(h.calls.some((c) => c.label?.startsWith('validate lead'))).toBe(false);
  expect(h.logs.some((l) => l.includes('an unattended run never gets one'))).toBe(true);
  expect(grantsOf(h.session.id)).toEqual([]);
});

test('one grant covers two leads on the target; it is capped by the scope and stored for the scope guard', async () => {
  const dir = huntFolder();
  const r = roles(dir, [LEAD1, LEAD2], (_title, marker) => {
    r.result(marker);
    return { reproduced: true, runs: PASS, controls: CONTROLS, evidence: '200 ' + marker, result: 'findings/acme-hunt/RESULT.txt', pairs: 'findings/acme-hunt/pairs.har', requests: 6, on: 'app.acme.example' };
  });
  const approvals = t.approvals.length;
  const h = await hunt(dir, { lane: 'web', url: 'https://app.acme.example' });
  expect(h.run.error).toBeUndefined();
  const asks = t.approvals.slice(approvals).filter((a) => a.includes('allow live requests to'));
  expect(asks.length).toBe(1);
  // the card names hosts, accounts, budget and rate, expiry and the scope line
  expect(asks[0]).toContain('app.acme.example');
  expect(asks[0]).toContain('tenantA (test)');
  expect(asks[0]).toContain('40 requests, 1 per second');
  expect(asks[0]).toContain('in 24 hours');
  expect(asks[0]).toContain('targets/acme/scope.yaml');
  expect(h.calls.filter((c) => c.label?.startsWith('validate lead')).length).toBe(2);
  expect(h.logs.some((l) => /Grant grant_\w+ covers lead 2/.test(l))).toBe(true);
  expect(h.result.leads.map((l) => l.status)).toEqual(['confirmed', 'confirmed']);
  const g = grantsOf(h.session.id);
  expect(g.length).toBe(1);
  expect(g[0].hosts).toEqual(['https://app.acme.example']);
  expect(g[0].requestBudget).toBe(40);
  expect(g[0].expiresAt - g[0].issuedAt).toBeLessThanOrEqual(24 * 3_600_000);
});

test('a source lead only the live host can prove switches to the web lane, logged and shown', async () => {
  const dir = huntFolder();
  const r = roles(dir, [{ ...LEAD1, needsLive: true }], (_title, marker) => {
    r.result(marker);
    return { reproduced: true, runs: PASS, controls: CONTROLS, evidence: '200 ' + marker, result: 'findings/acme-hunt/RESULT.txt', pairs: 'findings/acme-hunt/pairs.har', requests: 4 };
  });
  const h = await hunt(dir, { lane: 'source', url: 'https://app.acme.example' });
  expect(h.run.error).toBeUndefined();
  expect(h.logs.some((l) => l.startsWith('Lane: source -> web for the proof of lead 1'))).toBe(true);
  expect(h.result.laneChanges).toEqual([{ lead: 1, from: 'source', to: 'web', why: 'only the live host can prove it' }]);
  expect(h.notices.some((m) => m.meta!.type === 'lane' && m.meta!.to === 'web')).toBe(true);
  expect(h.result.leads[0].proofLane).toBe('web');
  expect(h.result.grants.asked).toBe(1);
  // the validator was told the live host and the grant's budget, not the lab
  const validate = t.requests.filter((x) => x.includes('Run the lane oracle')).pop() ?? '';
  expect(validate).toContain('Web black-box: in-scope hosts https://app.acme.example only');
  expect(readFileSync(join(dir, 'findings', 'acme-hunt', 'RESULT.txt'), 'utf8')).toContain('CANARY-');
});

test('lib.notice: a finding card sent as confirmed without 3 passing oracle runs shows partial', async () => {
  const svc = svcOf(t.engine);
  const s = await t.engine.createSession({ cwd: huntFolder() });
  const run = await svc.wait((await svc.startRun({ sessionId: s.id, script: `export const meta = { name: 'n', description: 'x', runtime: 'conclave' }
await lib.notice('finding', 'a', { n: 1, title: 'votes only', state: 'confirmed', refuter: { votes: [] } })
await lib.notice('finding', 'b', { n: 2, title: 'two runs', state: 'confirmed', oracle: { runs: [{ pass: true }, { pass: true }] } })
await lib.notice('finding', 'c', { n: 3, title: 'ran', state: 'confirmed', oracle: { runs: [{ pass: true }, { pass: true }, { pass: true }] } })
return 1` })).id);
  expect(run.error).toBeUndefined();
  const states = (t.engine.getMessages(s.id) as unknown as Array<{ meta?: Record<string, unknown> }>).filter((m) => m.meta?.type === 'finding').map((m) => m.meta!.state);
  expect(states).toEqual(['partial', 'partial', 'confirmed']);
});

test('preflight stops on a missing scope file, a host outside in_scope, and an expired scope', async () => {
  roles(huntFolder(), [], () => null);
  const missing = await hunt(huntFolder(''), { lane: 'source' });
  expect(missing.result.stopped).toBe('preflight');
  expect(missing.result.reason).toContain('does not exist');
  const outside = await hunt(huntFolder(), { lane: 'web', url: 'https://admin.acme.example' });
  expect(outside.result.reason).toContain('not in in_scope');
  const expired = await hunt(huntFolder(SCOPE.replace('2099-12-31', '2020-01-01')), { lane: 'source' });
  expect(expired.result.reason).toContain('expired on 2020-01-01');
  // nothing ran past preflight
  for (const h of [missing, outside, expired]) expect(h.calls.some((c) => c.kind === 'agent')).toBe(false);
});
