/**
 * Mock routes for the workflow engine (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 3.17):
 * the library, runs with their calls, logs, findings and worktrees, and the
 * controls. Runs move on timers and send the workflow.* events a real hub
 * sends.
 *
 * The busy hub: a finished review-changes run on the jose auth change with
 * three findings (one proven by a failing test, one confirmed, one waiting
 * for a verdict) and a kept test branch, and a deep-research run on Caddy
 * against Traefik that is still searching. A first-run hub has the library
 * and no runs.
 */
import type {
  FindingVerdict,
  StartWorkflowInput,
  WorkflowCall,
  WorkflowCallState,
  WorkflowDetail,
  WorkflowFinding,
  WorkflowLogLine,
  WorkflowPhaseDto,
  WorkflowRun,
  WorkflowRunDetail,
  WorkflowRunStatus,
  WorkflowSource,
  WorkflowSummary,
  WorktreeAction,
} from '@conclave/core/client';
import type { Message, Session } from '@conclave/core/types';
import type { MockCtx } from './index';
import { FANOUT_SESSION, fanOutFixture } from './fanout';

const MIN = 60_000;
const HOUR = 60 * MIN;

interface LibEntry {
  id: string;
  description: string;
  whenToUse: string;
  phases: string[];
  source: WorkflowSource;
  portable?: boolean;
  path?: string;
}

const LIBRARY: LibEntry[] = [
  { id: 'review-changes', description: 'Review a change: five finder lenses each run twice, citations checked in code, a three-vote refuter panel per finding, and failing tests for the worst ones', whenToUse: 'Before you merge or commit a change. args: { base?, focus?, votes? }', phases: ['Scope', 'Find', 'Check', 'Verify', 'Prove', 'Report'], source: 'builtin' },
  { id: 'deep-research', description: 'Research a question on the web: searchers that open every page they cite, two fact-checkers per claim who never see the draft, one writer', whenToUse: 'For a question that needs several sources or a comparison. args: { question, depth? }', phases: ['Frame', 'Search', 'Check', 'Write', 'Critic'], source: 'builtin' },
  { id: 'research-sweep', description: 'Map a codebase before a design: explorers by subsystem, entity, history and tests, then one merged map', whenToUse: 'Before you design a change in code you do not know yet. args: { question }', phases: ['Split', 'Explore', 'Merge', 'Critic'], source: 'builtin' },
  { id: 'plan-implement-verify', description: 'Understand, plan with a check per step, build one step at a time in one worktree, and let the tests and a review decide when it is done', whenToUse: 'For a real change that touches more than a line or two. args: { task, check? }', phases: ['Understand', 'Clarify', 'Plan', 'Implement', 'Verify', 'Fix'], source: 'builtin' },
  { id: 'fix-until-green', description: 'Run a check; a debugger finds the root cause and a builder fixes it, until it passes or two rounds make no progress', whenToUse: 'When a suite or build is red. args: { check, maxRounds?, isolate? }', phases: ['Check', 'Diagnose', 'Fix'], source: 'builtin' },
  { id: 'fix-issue', description: 'A reproduction test that must fail first, three fixes from different angles in worktrees, and a judge panel for the smallest correct one', whenToUse: 'For a bug report with a clear symptom. args: { issue, check }', phases: ['Localize', 'Reproduce', 'Fix', 'Test', 'Judge'], source: 'builtin' },
  { id: 'bug-hunt', description: 'Hunt for bugs until two rounds find nothing new, with a refuter panel per finding and failing tests for the top ones', whenToUse: 'To look for bugs in a codebase. args: { path?, maxRounds? }', phases: ['Angles', 'Find', 'Verify', 'Prove', 'Report'], source: 'builtin' },
  { id: 'security-audit', description: 'Every folder scanned or skipped with a reason, a threat model per component, research per lens, and a REACHABILITY, IMPACT and DEFENSES panel', whenToUse: 'For a security review of a repository or the homelab. args: { target?, devices? }', phases: ['Inventory', 'Threat model', 'Research', 'Sweep', 'Panel', 'Report'], source: 'builtin' },
  { id: 'design-panel', description: 'Four independent designs scored blind by three judges in both orders, then one design built from the winner', whenToUse: 'When a design choice is open and wide. args: { request }', phases: ['Rubric', 'Design', 'Judge', 'Synthesize'], source: 'builtin' },
  { id: 'ui-pass', description: 'A designer builds the change and takes screenshots; a fresh visual verifier that sees only the screenshots decides', whenToUse: 'For a visual change in the web app. args: { brief }', phases: ['Build', 'Look', 'Fix', 'Check'], source: 'builtin' },
  { id: 'migrate', description: 'Discover the sites, pilot one unit, then escalating batches in worktrees with a circuit breaker', whenToUse: 'For the same change across many packages. args: { goal, check, units? }', phases: ['Discover', 'Pilot', 'Approve', 'Migrate', 'Report'], source: 'builtin' },
  { id: 'compare-harnesses', description: 'One task with several harnesses in separate worktrees, checked, and scored blind', whenToUse: 'To compare harnesses or models on a real task. args: { task, check, arms? }', phases: ['Run', 'Check', 'Judge', 'Report'], source: 'builtin' },
  { id: 'race', description: 'Race several agents on one task in separate worktrees, check each, and keep the best passing change', whenToUse: 'When a task has more than one plausible solution. args: { task, check, n?, arms? }', phases: ['Run', 'Check', 'Judge', 'Report'], source: 'builtin' },
  { id: 'claude-security:scan', description: 'Claude Security scan pipeline: inventory, threat-model, research and sweep, then a three-lens adversarial panel', whenToUse: 'Run by the Security Lead from the scan job.', phases: ['Inventory', 'Threat model', 'Research', 'Sweep', 'Panel'], source: 'plugin', portable: true, path: '~/.conclave/plugins/claude-security/workflows/scan.js' },
  { id: 'nightly-deps', description: 'Check outdated dependencies in every repo under ~/code and open one branch per repo with the safe bumps', whenToUse: 'From the nightly routine. args: { root? }', phases: ['List', 'Bump', 'Check'], source: 'user', path: '~/.conclave/workflows/nightly-deps.js' },
];

type CallSeed = Partial<WorkflowCall> & { label: string; phase: string; state: WorkflowCallState };

interface MockRun {
  run: WorkflowRun;
  calls: WorkflowCall[];
  logs: WorkflowLogLine[];
  findings: WorkflowFinding[];
  result?: unknown;
  /** Steps the timer plays for a live run. */
  plan?: Array<() => void>;
  timer?: ReturnType<typeof setTimeout>;
}

const counts = (calls: WorkflowCall[]) => {
  const c = { agents: 0, queued: 0, running: 0, done: 0, cached: 0, failed: 0, skipped: 0, parked: 0 };
  for (const x of calls) {
    if (x.kind !== 'agent') continue;
    c.agents++;
    c[x.state]++;
  }
  return c;
};

const phasesOf = (titles: string[]): WorkflowPhaseDto[] => titles.map((title) => ({ title }));

function call(seq: number, s: CallSeed, at: number): WorkflowCall {
  const tokens = s.inputTokens ?? (s.state === 'queued' ? 0 : 18_000 + ((seq * 7919) % 22_000));
  const out = s.outputTokens ?? (s.state === 'queued' ? 0 : 900 + ((seq * 104729) % 2600));
  return {
    seq,
    kind: 'agent',
    childSessionId: `s_wfchild_${seq}`,
    promptPreview: `You are reviewing a change in finder mode. Report every problem this change introduces that the author would want to fix: discrete and actionable, with the affected code shown, not guessed. (${s.label})`,
    attempt: s.state === 'queued' ? 0 : 1,
    inputTokens: tokens,
    outputTokens: out,
    costUsd: s.costUsd ?? Math.round(((tokens * 3 + out * 15) / 1e6) * 1000) / 1000,
    queuedAt: at,
    ...(s.state !== 'queued' ? { startedAt: at + 2000 } : {}),
    ...(s.state === 'done' || s.state === 'failed' || s.state === 'cached' ? { finishedAt: at + 60_000 + ((seq * 31) % 90) * 1000 } : {}),
    ...s,
  } as WorkflowCall;
}

function totals(r: MockRun): void {
  r.run.counts = counts(r.calls);
  r.run.inputTokens = r.calls.reduce((a, c) => a + c.inputTokens, 0);
  r.run.outputTokens = r.calls.reduce((a, c) => a + c.outputTokens, 0);
  r.run.costUsd = Math.round(r.calls.reduce((a, c) => a + c.costUsd, 0) * 100) / 100;
}

export function registerWorkflows(ctx: MockCtx): void {
  const runs = new Map<string, MockRun>();
  const now = Date.now();
  const lastRunOf = (name: string) => [...runs.values()].filter((r) => r.run.name === name).sort((a, b) => b.run.createdAt - a.run.createdAt)[0];

  const summary = (e: LibEntry): WorkflowSummary => {
    const last = lastRunOf(e.id);
    return {
      id: e.id,
      name: e.id,
      description: e.description,
      whenToUse: e.whenToUse,
      phases: phasesOf(e.phases),
      source: e.source,
      ...(e.path ? { path: e.path } : {}),
      portable: e.portable ?? e.source !== 'builtin',
      runnable: true,
      ...(last ? { lastRun: { id: last.run.id, status: last.run.status, createdAt: last.run.createdAt, ...(last.run.finishedAt ? { finishedAt: last.run.finishedAt } : {}) } } : {}),
    };
  };

  const emitRun = (r: MockRun) => {
    totals(r);
    ctx.emit({ type: 'workflow.run', run: structuredClone(r.run) });
  };
  const emitCall = (r: MockRun, c: WorkflowCall) => ctx.emit({ type: 'workflow.agent', runId: r.run.id, call: structuredClone(c) });
  const addLog = (r: MockRun, text: string) => {
    const line = { n: r.logs.length + 1, ts: Date.now(), text };
    r.logs.push(line);
    ctx.emit({ type: 'workflow.log', runId: r.run.id, ts: line.ts, text });
  };
  const setPhase = (r: MockRun, title: string) => {
    const i = r.run.phases.findIndex((p) => p.title === title);
    r.run.phaseIndex = i;
    r.run.phaseTitle = title;
    ctx.emit({ type: 'workflow.phase', runId: r.run.id, index: i, title });
    emitRun(r);
  };

  /** Play a run's plan, one step every 2.4s, while it is running. */
  const tick = (r: MockRun) => {
    if (r.timer) clearTimeout(r.timer);
    r.timer = setTimeout(() => {
      if (r.run.status !== 'running') return;
      const step = r.plan?.shift();
      if (!step) return;
      step();
      tick(r);
    }, 2400);
  };

  // ----- the finished review-changes run -----
  if (!ctx.FRESH) {
    const t0 = now - 2 * HOUR;
    const id = 'wfr_review1';
    const seeds: CallSeed[] = [];
    for (const lens of ['correctness', 'contracts', 'security', 'tests', 'errors'])
      for (const order of ['forward', 'reversed']) seeds.push({ label: `find ${lens} ${order}`, phase: 'Find', state: 'done', agentType: 'reviewer', model: lens === 'correctness' ? 'anthropic/claude-opus-5-5' : 'anthropic/claude-sonnet-5-5', lastTool: 'Read src/server/auth.ts', resultPreview: '{"findings":[{"file":"packages/server/src/auth.ts","line":88,...}]}' });
    const targets = ['packages/server/src/auth.ts:88', 'packages/server/src/auth.ts:131', 'packages/core/src/client/index.ts:412', 'packages/server/src/guard.ts:40', 'packages/server/src/auth.ts:57'];
    targets.forEach((t, ti) => {
      for (let v = 1; v <= 3; v++) seeds.push({ label: `verify ${t} #${v}`, phase: 'Verify', state: ti === 4 && v === 3 ? 'failed' : 'done', agentType: 'verifier', model: 'anthropic/claude-opus-5-5', effort: 'xhigh', lastTool: `Read ${t.split(':')[0]}`, ...(ti === 4 && v === 3 ? { error: 'provider overloaded after 3 retries' } : {}) });
    });
    seeds.push({ label: 'prove packages/server/src/auth.ts:88', phase: 'Prove', state: 'done', agentType: 'tester', model: 'anthropic/claude-sonnet-5-5', lastTool: 'Bash bun test packages/server/test/auth-expiry.test.ts', worktree: { branch: `conclave/wf/${id}/26`, commit: '9f3c2a1e4b', state: 'kept', files: 1 } });
    seeds.push({ label: 'prove packages/server/src/auth.ts:131', phase: 'Prove', state: 'done', agentType: 'tester', model: 'anthropic/claude-sonnet-5-5', lastTool: 'Bash bun test packages/server/test/auth-refresh.test.ts', worktree: { branch: `conclave/wf/${id}/27`, state: 'removed', files: 0 } });
    const calls = seeds.map((s, i) => call(i + 1, s, t0 + i * 20_000));
    const findings: WorkflowFinding[] = [
      { id: 'wff_1', runId: id, workflow: 'review-changes', project: '~/code/conclave', findingKey: 'a1', file: 'packages/server/src/auth.ts', line: 88, title: 'Expired tokens pass: jwtVerify gets no clockTolerance and the exp check is skipped when iat is missing', priority: 'P1', proven: true, votes: ['confirmed', 'confirmed', 'confirmed'], data: { quote: "const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] })", scenario: 'A token with exp in the past and no iat claim', confidence: 'high' }, createdAt: t0 + 30 * MIN },
      { id: 'wff_2', runId: id, workflow: 'review-changes', project: '~/code/conclave', findingKey: 'a2', file: 'packages/core/src/client/index.ts', line: 412, title: 'The client still sends the old X-Conclave-Token header the server no longer reads', priority: 'P2', proven: false, votes: ['confirmed', 'confirmed', 'refuted'], data: { quote: "headers['x-conclave-token'] = this.token", scenario: 'Any request from a client built before this change', confidence: 'medium' }, createdAt: t0 + 30 * MIN },
      { id: 'wff_3', runId: id, workflow: 'review-changes', project: '~/code/conclave', findingKey: 'a3', file: 'packages/server/src/guard.ts', line: 40, title: 'A failed verify counts twice toward the lockout when the token is also malformed', priority: 'P3', proven: false, votes: ['confirmed', 'confirmed', 'unverifiable'], verdict: 'dismissed', reason: 'The double count is intended: malformed tokens are a stronger signal.', data: { quote: 'guard.fail(ip); guard.fail(ip)', scenario: 'A malformed token on a bad IP' }, createdAt: t0 + 30 * MIN, decidedAt: t0 + 50 * MIN },
    ];
    const r: MockRun = {
      run: {
        id,
        name: 'review-changes',
        description: LIBRARY[0].description,
        source: 'builtin',
        status: 'done',
        sessionId: 's_auth',
        device: 'arch-desktop',
        cwd: '~/code/conclave',
        phases: phasesOf(LIBRARY[0].phases),
        phaseIndex: 5,
        phaseTitle: 'Report',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        counts: counts(calls),
        scriptPath: `~/.conclave/workflows/runs/${id}.js`,
        portable: false,
        createdAt: t0,
        startedAt: t0 + 1000,
        finishedAt: t0 + 34 * MIN,
      },
      calls,
      logs: [
        'Reviewing uncommitted changes against HEAD: 7 files, 18,422 chars of diff',
        'Finders reported 23 candidates',
        'Dropped 6 P2/P3 candidates that only one pass saw',
        'citation check dropped 4 of 17 findings (quote not within 3 lines of the cited line)',
        'dropped 2 findings similar to 3 or more that the owner dismissed before',
        'panel for packages/server/src/auth.ts:57 was incomplete (2 of 3 votes); not kept',
        'Verifying the top 5 by priority',
      ].map((text, i) => ({ n: i + 1, ts: t0 + (i + 1) * 3 * MIN, text })),
      findings,
      result: {
        verdict: 'changes needed',
        report:
          'Verdict: changes needed.\n\nProven by a failing test:\n- P1 packages/server/src/auth.ts:88 Expired tokens pass: jwtVerify gets no clockTolerance and the exp check is skipped when iat is missing. Trigger: a token with exp in the past and no iat claim\n\nConfirmed by 2 or 3 of 3 refuters:\n- P2 packages/core/src/client/index.ts:412 The client still sends the old X-Conclave-Token header the server no longer reads\n- P3 packages/server/src/guard.ts:40 A failed verify counts twice toward the lockout\n\nDropped: singlePass 6, citation 4, dismissed 2, notVerified 0, refuted 8.\nCoverage: 7 files read.',
        dropped: { singlePass: 6, citation: 4, dismissed: 2, refuted: 8 },
        coverage: { read: ['packages/server/src/auth.ts', 'packages/server/src/guard.ts', 'packages/core/src/client/index.ts'], notReached: [] },
      },
    };
    totals(r);
    runs.set(id, r);
    // one finder's transcript, for the side panel
    ctx.db.messages.set('s_wfchild_1', [
      { id: 'm_wfc_1', sessionId: 's_wfchild_1', seq: 1, role: 'user', kind: 'normal', createdAt: t0, content: [{ type: 'text', text: calls[0].promptPreview ?? '' }] },
      { id: 'm_wfc_2', sessionId: 's_wfchild_1', seq: 2, role: 'assistant', kind: 'normal', createdAt: t0 + 4000, model: 'anthropic/claude-opus-5-5', content: [{ type: 'text', text: 'Reading the changed auth path first.' }, { type: 'tool_use', id: 'tu_c1', name: 'Read', input: { file_path: '~/code/conclave/packages/server/src/auth.ts' } }] },
      { id: 'm_wfc_3', sessionId: 's_wfchild_1', seq: 3, role: 'user', kind: 'normal', createdAt: t0 + 5000, content: [{ type: 'tool_result', toolUseId: 'tu_c1', content: '88  const { payload } = await jwtVerify(token, key, { algorithms: [\'HS256\'] })' }] },
      { id: 'm_wfc_4', sessionId: 's_wfchild_1', seq: 4, role: 'assistant', kind: 'normal', createdAt: t0 + 9000, model: 'anthropic/claude-opus-5-5', content: [{ type: 'text', text: 'One candidate: `jwtVerify` at auth.ts:88 gets no `clockTolerance`, and the old code checked `exp` itself only when `iat` was set. Reporting it with the trigger.' }, { type: 'tool_use', id: 'tu_c2', name: 'StructuredOutput', input: { findings: [] } }] },
    ]);
    calls[0].resultPreview = '{"findings":[{"file":"packages/server/src/auth.ts","line":88,"title":"Expired tokens pass","priority":"P1"}],"read":["packages/server/src/auth.ts"]}';

    // ----- a finished race, its winner waiting for Keep winner -----
    {
      const qid = 'wfr_race1';
      const tq = now - 50 * MIN;
      const racers: CallSeed[] = [
        { label: 'racer 1', phase: 'Run', state: 'done', agentType: 'coder', model: 'anthropic/claude-sonnet-5-5', lastTool: 'Bash bun test packages/core/test/util', worktree: { branch: `conclave/wf/${qid}/1`, commit: '3be81f02c4', state: 'kept', files: 2 } },
        { label: 'racer 2', phase: 'Run', state: 'done', agentType: 'coder', model: 'anthropic/claude-opus-5-5', lastTool: 'Bash bun test packages/core/test/util', worktree: { branch: `conclave/wf/${qid}/2`, commit: 'c09d7a51e8', state: 'kept', files: 5 } },
        { label: 'racer 3', phase: 'Run', state: 'done', agentType: 'coder', model: 'openai/gpt-5.5', lastTool: 'Bash bun test packages/core/test/util', worktree: { branch: `conclave/wf/${qid}/3`, commit: '71f4ea9b20', state: 'kept', files: 3 } },
        ...[1, 2, 3].map((j) => ({ label: `judge ${j}a`, phase: 'Judge', state: 'done' as const, model: 'anthropic/claude-sonnet-5-5' })),
      ];
      const qcalls = racers.map((s, i) => call(i + 1, s, tq + i * 15_000));
      const race: MockRun = {
        run: { id: qid, name: 'race', description: LIBRARY.find((e) => e.id === 'race')!.description, source: 'builtin', status: 'done', sessionId: 's_auth', device: 'arch-desktop', cwd: '~/code/conclave', phases: phasesOf(['Run', 'Check', 'Judge', 'Report']), phaseIndex: 3, phaseTitle: 'Report', inputTokens: 0, outputTokens: 0, costUsd: 0, counts: counts(qcalls), scriptPath: `~/.conclave/workflows/runs/${qid}.js`, portable: false, createdAt: tq, startedAt: tq + 900, finishedAt: tq + 21 * MIN },
        calls: qcalls,
        logs: [{ n: 1, ts: tq + 18 * MIN, text: 'racer 3 failed the check: 2 tests in packages/core/test/util/duration.test.ts' }],
        findings: [],
        result: {
          task: 'Parse durations like 1h30m in the routine scheduler',
          race: {
            winner: 1,
            reasons: ['Smallest change that does the task: one parser and its tests, no new options.', 'Handles 90m and 1h30m the same way and rejects a bare number with a clear error.'],
            votes: [3, 0],
            arms: [
              { arm: 'racer 1', ran: true, seq: 1, model: 'anthropic/claude-sonnet-5-5', passed: true, files: 2, score: 8.7 },
              { arm: 'racer 2', ran: true, seq: 2, model: 'anthropic/claude-opus-5-5', passed: true, files: 5, score: 6.2 },
              { arm: 'racer 3', ran: true, seq: 3, model: 'openai/gpt-5.5', passed: false, files: 3 },
            ],
          },
          report: '**racer 1** wins.\n\n- racer 1: check passed, score 8.7\n- racer 2: check passed, score 6.2\n- racer 3: check failed\n\nNothing is merged yet. Keep winner applies its branch; the other branches are deleted only after that.',
        },
      };
      totals(race);
      runs.set(qid, race);
    }

    // ----- the running deep-research run -----
    const t1 = now - 6 * MIN;
    const rid = 'wfr_research1';
    const rcalls: WorkflowCall[] = [
      call(1, { label: 'frame', phase: 'Frame', state: 'done', agentType: 'researcher', model: 'anthropic/claude-sonnet-5-5', lastTool: 'MemorySearch homelab reverse proxy' }, t1),
      ...[1, 2, 3, 4, 5].map((i) => call(i + 1, { label: `search r1 ${i}`, phase: 'Search', state: i <= 2 ? 'done' : i === 3 ? 'running' : 'queued', agentType: 'web-searcher', model: 'anthropic/claude-haiku-5-5', ...(i <= 3 ? { lastTool: i === 3 ? 'WebFetch doc.traefik.io' : 'WebFetch caddyserver.com' } : {}) }, t1 + i * 30_000)),
    ];
    const research: MockRun = {
      run: {
        id: rid,
        name: 'deep-research',
        description: LIBRARY[1].description,
        source: 'builtin',
        status: 'running',
        sessionId: 's_wfresearch',
        toolUseId: 'tu_wf_research',
        device: 'local',
        cwd: '~',
        phases: phasesOf(LIBRARY[1].phases),
        phaseIndex: 1,
        phaseTitle: 'Search',
        budget: { tokens: 2_000_000 },
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        counts: counts(rcalls),
        scriptPath: `~/.conclave/workflows/runs/${rid}.js`,
        portable: false,
        createdAt: t1,
        startedAt: t1 + 800,
      },
      calls: rcalls,
      logs: [{ n: 1, ts: t1 + 40_000, text: 'comparison question: 5 sub-questions' }],
      findings: [],
    };
    totals(research);
    const rc = (seq: number) => research.calls.find((c) => c.seq === seq)!;
    const finish = (seq: number, lastTool?: string) => {
      const c = rc(seq);
      Object.assign(c, { state: 'done', finishedAt: Date.now(), outputTokens: c.outputTokens || 1400, inputTokens: c.inputTokens || 22_000, costUsd: c.costUsd || 0.04, ...(lastTool ? { lastTool } : {}) });
      emitCall(research, c);
      emitRun(research);
    };
    const start = (seq: number, lastTool: string) => {
      const c = rc(seq);
      Object.assign(c, { state: 'running', attempt: 1, startedAt: Date.now(), lastTool, inputTokens: 12_000, outputTokens: 300, costUsd: 0.01 });
      emitCall(research, c);
      ctx.emit({ type: 'workflow.progress', runId: rid, callSeq: seq, lastTool });
      emitRun(research);
    };
    const add = (s: CallSeed) => {
      const c = call(research.calls.length + 1, s, Date.now());
      research.calls.push(c);
      emitCall(research, c);
      emitRun(research);
      return c.seq;
    };
    research.plan = [
      () => {
        rc(4).lastTool = 'WebFetch github.com/traefik/traefik/releases';
        ctx.emit({ type: 'workflow.progress', runId: rid, callSeq: 4, lastTool: rc(4).lastTool! });
        start(5, 'WebSearch caddy vs traefik memory use');
      },
      () => finish(4, 'WebFetch github.com/traefik/traefik/releases'),
      () => start(6, 'WebSearch traefik proxmox lxc docker labels'),
      () => finish(5),
      () => {
        finish(6);
        addLog(research, '3 claims came from pages the searcher did not open; they stay leads');
        setPhase(research, 'Check');
        for (let i = 1; i <= 4; i++) add({ label: `check ${i}a`, phase: 'Check', state: 'queued', agentType: 'fact-checker', model: 'anthropic/claude-sonnet-5-5' });
      },
      () => start(7, 'WebFetch caddyserver.com/docs/automatic-https'),
      () => start(8, 'WebFetch doc.traefik.io/traefik/https/acme'),
      () => finish(7),
      () => start(9, 'WebFetch caddyserver.com/docs/caddyfile'),
      () => finish(8),
      () => {
        // the agent waits on the owner for a fetch it may not make on its own
        start(10, 'needs approval: Fetch community.traefik.io');
        rc(10).waiting = 'approval';
        ctx.emit({ type: 'workflow.progress', runId: rid, callSeq: 10, lastTool: rc(10).lastTool!, waiting: 'approval' });
      },
      () => {
        Object.assign(rc(10), { waiting: undefined, lastTool: 'WebFetch community.traefik.io' });
        ctx.emit({ type: 'workflow.progress', runId: rid, callSeq: 10, lastTool: rc(10).lastTool!, waiting: false });
        finish(9);
      },
      () => {
        finish(10);
        setPhase(research, 'Write');
        const s = add({ label: 'write', phase: 'Write', state: 'queued', agentType: 'synthesizer', model: 'anthropic/claude-sonnet-5-5' });
        start(s, 'Write the report');
      },
      () => {
        finish(research.calls.length);
        setPhase(research, 'Critic');
        const s = add({ label: 'critic', phase: 'Critic', state: 'queued', model: 'anthropic/claude-sonnet-5-5' });
        start(s, 'Read the report');
      },
      () => {
        finish(research.calls.length);
        research.run.status = 'done';
        research.run.finishedAt = Date.now();
        research.result = {
          report: 'Use Caddy for the homelab front door. It gets and renews certificates with no config, its Caddyfile for eight services is about 40 lines, and it uses less memory idle [1][2]. Traefik wins only if you move the services to Docker labels, which you do not use on Proxmox LXCs [3].\n\nSources\n[1] caddyserver.com/docs/automatic-https\n[2] caddyserver.com/docs/caddyfile\n[3] doc.traefik.io/traefik/providers/docker',
          sources: ['https://caddyserver.com/docs/automatic-https', 'https://caddyserver.com/docs/caddyfile', 'https://doc.traefik.io/traefik/providers/docker'],
          unopened: ['https://www.reddit.com/r/selfhosted/comments/caddy_vs_traefik'],
        };
        addLog(research, 'Pages that could not be opened: https://www.reddit.com/r/selfhosted/comments/caddy_vs_traefik');
        emitRun(research);
      },
    ];
    runs.set(rid, research);
    tick(research);

    // the sessions that started them, with the Workflow tool calls
    if (!ctx.db.sessions.has('s_wfresearch')) {
      const s: Session = {
        id: 's_wfresearch',
        title: 'Caddy or Traefik for the homelab',
        agent: 'researcher',
        model: 'anthropic/claude-sonnet-5-5',
        mode: 'agent',
        permissionMode: 'default',
        cwd: '~',
        device: 'local',
        status: 'running',
        tags: ['homelab'],
        pinned: false,
        archived: false,
        ultra: true,
        createdAt: t1 - MIN,
        updatedAt: Date.now(),
        stats: { messages: 2, inputTokens: 14_000, outputTokens: 800, cacheReadTokens: 0, costUsd: 0.05 },
      };
      ctx.db.sessions.set(s.id, s);
      const msgs: Message[] = [
        { id: 'm_wfr_1', sessionId: s.id, seq: 1, role: 'user', kind: 'normal', createdAt: t1 - MIN, content: [{ type: 'text', text: 'Caddy or Traefik in front of the homelab services? Research it properly.' }] },
        {
          id: 'm_wfr_2',
          sessionId: s.id,
          seq: 2,
          role: 'assistant',
          kind: 'normal',
          createdAt: t1 - 50_000,
          model: 'anthropic/claude-sonnet-5-5',
          content: [
            { type: 'text', text: 'Running deep-research: a comparison with sources that need checking. A subagent reads your current proxy config meanwhile.' },
            { type: 'tool_use', id: 'tu_task_proxy', name: 'Task', input: { description: 'Read the homelab proxy config', subagent_type: 'explore', prompt: 'Find the reverse proxy config on the homelab and list each service it routes, with its port.', run_in_background: true } },
            { type: 'tool_use', id: 'tu_wf_research', name: 'Workflow', input: { name: 'deep-research', args: { question: 'Caddy or Traefik as the reverse proxy for a Proxmox homelab', depth: 'normal' }, estimate: { agents: 16, tokens: 900_000 } } },
          ],
        },
        // a subagent in the background answers at once and works on in its own session
        { id: 'm_wfr_3', sessionId: s.id, seq: 3, role: 'user', kind: 'normal', createdAt: t1 - 49_000, content: [{ type: 'tool_result', toolUseId: 'tu_task_proxy', content: 'Subagent "explore" started in the background (session s_wfr_explore). You will be notified when it finishes.', meta: { sessionId: 's_wfr_explore', agent: 'explore', background: true } }] },
      ];
      ctx.db.messages.set(s.id, msgs);
      registerProxySubagent(ctx, s.id, t1 - 49_000);
    }
    const authMsgs = ctx.db.messages.get('s_auth');
    if (authMsgs && !authMsgs.some((m) => m.id === 'm_wf_review')) {
      const at = t0 - 30_000;
      const nextSeq = Math.max(0, ...authMsgs.map((m) => m.seq)) + 1;
      authMsgs.push(
        { id: 'm_wf_review', sessionId: 's_auth', seq: nextSeq, role: 'assistant', kind: 'normal', createdAt: at, model: 'anthropic/claude-sonnet-5-5', content: [{ type: 'tool_use', id: 'tu_wf_review', name: 'Workflow', input: { name: 'review-changes', estimate: { agents: 30, tokens: 1_200_000 } } }] },
        { id: 'm_wf_review_r', sessionId: 's_auth', seq: nextSeq + 1, role: 'user', kind: 'normal', createdAt: t0 + 34 * MIN, content: [{ type: 'tool_result', toolUseId: 'tu_wf_review', content: 'Workflow review-changes done. Run wfr_review1.', meta: { workflowRunId: 'wfr_review1' } }] },
      );
    }
    // a four-subagent fan-out and a three-phase workflow (mock/fanout.ts)
    if (!ctx.db.sessions.has(FANOUT_SESSION)) {
      const f = fanOutFixture(now);
      for (const s of [f.session, ...f.children]) ctx.db.sessions.set(s.id, s);
      ctx.db.messages.set(f.session.id, f.messages);
      runs.set(f.run.id, { run: f.run, calls: f.calls, logs: [], findings: [] });
    }
  }

  const find = (id: string): MockRun => runs.get(id) ?? ctx.notFound();
  const detail = (r: MockRun): WorkflowRunDetail => {
    totals(r);
    const panels = r.calls.filter((c) => c.agentType === 'verifier').length / 3;
    return {
      run: structuredClone(r.run),
      meta: { name: r.run.name, description: r.run.description ?? '', phases: r.run.phases, runtime: 'conclave' },
      calls: structuredClone(r.calls),
      logs: r.logs.slice(),
      ...(r.result !== undefined ? { result: r.result } : {}),
      findings: r.findings.slice(),
      ...(panels >= 1 ? { refutedRate: 0.4 } : {}),
    };
  };
  const status = (r: MockRun, s: WorkflowRunStatus) => {
    r.run.status = s;
    if (['done', 'failed', 'stopped', 'budget'].includes(s)) r.run.finishedAt = Date.now();
    emitRun(r);
  };

  ctx.on('GET', '/api/workflows', () => LIBRARY.map(summary));
  ctx.on('GET', '/api/workflows/runs', ({ query }) => {
    let list = [...runs.values()].map((r) => (totals(r), structuredClone(r.run))).sort((a, b) => b.createdAt - a.createdAt);
    const sid = query.get('sessionId');
    if (sid) list = list.filter((r) => r.sessionId === sid);
    const st = query.get('status');
    if (st) list = list.filter((r) => r.status === st);
    return list.slice(0, Number(query.get('limit')) || 50);
  });
  ctx.on('POST', '/api/workflows/runs', async ({ body }) => {
    const input = (body ?? {}) as StartWorkflowInput;
    const e = LIBRARY.find((x) => x.id === input.name) ?? (input.script ? { id: /name:\s*['"]([^'"]+)/.exec(input.script)?.[1] ?? 'inline', description: 'Inline script', whenToUse: '', phases: ['Run'], source: 'inline' as const } : undefined);
    if (!e) return ctx.fail(404, `workflow ${input.name} not found`);
    await ctx.sleep(250);
    const id = ctx.uid('wfr');
    const t = Date.now();
    const phases = phasesOf(e.phases.slice(0, 3));
    const r: MockRun = {
      run: { id, name: e.id, description: e.description, source: e.source, status: 'running', ...(input.sessionId ? { sessionId: input.sessionId } : {}), device: input.device ?? 'local', cwd: input.cwd ?? '~', phases, phaseIndex: -1, ...(input.budget ? { budget: input.budget } : {}), inputTokens: 0, outputTokens: 0, costUsd: 0, counts: counts([]), scriptPath: `~/.conclave/workflows/runs/${id}.js`, portable: e.source !== 'builtin', createdAt: t, startedAt: t },
      calls: [],
      logs: [],
      findings: [],
    };
    const addCall = (label: string, phase: string) => {
      const c = call(r.calls.length + 1, { label, phase, state: 'running', model: 'anthropic/claude-sonnet-5-5', lastTool: 'Read README.md', inputTokens: 9_000, outputTokens: 200, costUsd: 0.01 }, Date.now());
      r.calls.push(c);
      emitCall(r, c);
      emitRun(r);
      return c;
    };
    const done = (c: WorkflowCall) => {
      Object.assign(c, { state: 'done', finishedAt: Date.now(), inputTokens: 21_000, outputTokens: 1_300, costUsd: 0.08, resultPreview: 'ok' });
      emitCall(r, c);
      emitRun(r);
    };
    let a: WorkflowCall | undefined;
    let b: WorkflowCall | undefined;
    r.plan = [
      () => {
        setPhase(r, phases[0].title);
        a = addCall(`${phases[0].title.toLowerCase()} 1`, phases[0].title);
      },
      () => {
        done(a!);
        if (phases[1]) setPhase(r, phases[1].title);
        b = addCall(`${(phases[1] ?? phases[0]).title.toLowerCase()} 1`, (phases[1] ?? phases[0]).title);
      },
      () => {
        done(b!);
        addLog(r, 'Finished in the mock: a real hub runs the whole script.');
        r.result = { report: `${e.id} finished in the mock hub.` };
        status(r, 'done');
      },
    ];
    runs.set(id, r);
    emitRun(r);
    tick(r);
    return structuredClone(r.run);
  });
  ctx.on('GET', '/api/workflows/runs/:id', ({ params }) => detail(find(params[0])));
  ctx.on('POST', '/api/workflows/runs/:id/pause', ({ params }) => {
    const r = find(params[0]);
    if (r.run.status !== 'running') return ctx.fail(409, 'the run is not running');
    addLog(r, 'Paused: running calls finish, new ones wait.');
    status(r, 'paused');
    return structuredClone(r.run);
  });
  ctx.on('POST', '/api/workflows/runs/:id/resume', ({ params }) => {
    const r = find(params[0]);
    addLog(r, r.run.status === 'paused' ? 'Resumed.' : `Resumed: ${r.calls.filter((c) => c.state === 'done').length} answers in the journal.`);
    if (r.run.status !== 'paused' && r.run.status !== 'running') {
      r.calls = r.calls.map((c) => (c.state === 'done' ? { ...c, state: 'cached' as const } : c));
      r.result = r.result ?? { report: 'Replayed from the journal.' };
      status(r, 'done');
      return structuredClone(r.run);
    }
    status(r, 'running');
    tick(r);
    return structuredClone(r.run);
  });
  ctx.on('POST', '/api/workflows/runs/:id/stop', ({ params }) => {
    const r = find(params[0]);
    if (r.timer) clearTimeout(r.timer);
    for (const c of r.calls) if (c.state === 'running' || c.state === 'queued') Object.assign(c, { state: 'failed', error: 'the run was stopped', finishedAt: Date.now() });
    r.run.error = 'stopped by the owner';
    addLog(r, 'Stopped by the owner.');
    status(r, 'stopped');
    return structuredClone(r.run);
  });
  ctx.on('POST', '/api/workflows/runs/:id/rerun', ({ params, body }) => {
    const r = find(params[0]);
    const from = Number(body?.fromSeq);
    r.calls = r.calls.map((c) => (c.seq < from ? { ...c, state: 'cached' as const } : c));
    addLog(r, `Rerun from call ${from}: ${from - 1} earlier answers replay from the journal.`);
    status(r, 'done');
    return structuredClone(r.run);
  });
  ctx.on('POST', '/api/workflows/runs/:id/calls/:seq/skip', ({ params }) => {
    const r = find(params[0]);
    const c = r.calls.find((x) => x.seq === Number(params[1]));
    if (!c || (c.state !== 'running' && c.state !== 'queued' && c.state !== 'parked')) return ctx.fail(409, 'that call is not waiting or running');
    Object.assign(c, { state: 'skipped', error: 'skipped by the owner', finishedAt: Date.now() });
    addLog(r, `Skipped call ${c.seq} (${c.label}); it returns null.`);
    emitCall(r, c);
    emitRun(r);
    return structuredClone(r.run);
  });
  ctx.on('POST', '/api/workflows/runs/:id/calls/:seq/worktree', async ({ params, body }) => {
    const r = find(params[0]);
    const c = r.calls.find((x) => x.seq === Number(params[1]));
    if (!c?.worktree) return ctx.fail(409, 'that call kept no worktree branch');
    const action = body?.action as WorktreeAction;
    await ctx.sleep(300);
    if (action === 'diff')
      return {
        ok: true,
        state: c.worktree.state,
        output:
          'diff --git a/packages/server/test/auth-expiry.test.ts b/packages/server/test/auth-expiry.test.ts\nnew file mode 100644\n--- /dev/null\n+++ b/packages/server/test/auth-expiry.test.ts\n@@ -0,0 +1,14 @@\n+import { expect, test } from "bun:test";\n+import { verifyToken } from "../src/auth";\n+\n+test("an expired token without iat is rejected", async () => {\n+  const token = await sign({ sub: "owner", exp: 1_000 });\n+  await expect(verifyToken(token)).rejects.toThrow("expired");\n+});\n',
      };
    c.worktree = { ...c.worktree, state: action === 'discard' ? 'discarded' : 'merged' };
    emitCall(r, c);
    return { ok: true, state: c.worktree.state, output: action === 'discard' ? `Deleted branch ${c.worktree.branch}.` : `Merged ${c.worktree.branch}.` };
  });
  ctx.on('POST', '/api/workflows/runs/:id/keep', async ({ params, body }) => {
    const r = find(params[0]);
    const race = (r.result as { race?: { winner: number | null; arms: Array<{ seq?: number }> } } | undefined)?.race;
    if (!race || race.winner === null) return ctx.fail(409, 'This run has no race winner to keep.');
    await ctx.sleep(400);
    let discarded = 0;
    for (const c of r.calls) {
      if (!c.worktree || !race.arms.some((a) => a.seq === c.seq)) continue;
      if (c.seq === race.winner) c.worktree = { ...c.worktree, state: 'merged' };
      else if (c.worktree.state === 'kept') {
        c.worktree = { ...c.worktree, state: 'discarded' };
        discarded++;
      }
      emitCall(r, c);
    }
    const pr = body?.how === 'pr' ? { number: 214, url: 'https://github.com/sam-rivera/portfolio/pull/214' } : undefined;
    return { ok: true, output: pr ? `Opened pull request #${pr.number}.` : 'Applied the winner.', discarded, ...(pr ? { pr } : {}) };
  });
  ctx.on('POST', '/api/workflows/runs/:id/findings/:fid', ({ params, body }) => {
    const r = find(params[0]);
    const f = r.findings.find((x) => x.id === params[1]);
    if (!f) return ctx.notFound();
    const verdict = body?.verdict as FindingVerdict;
    if (verdict === 'dismissed' && !String(body?.reason ?? '').trim()) return ctx.fail(400, 'a dismissal needs a reason');
    Object.assign(f, { verdict, ...(body?.reason ? { reason: String(body.reason) } : {}), decidedAt: Date.now() });
    return structuredClone(f);
  });
  ctx.on('GET', '/api/workflows/:id', ({ params }) => {
    const id = decodeURIComponent(params[0]);
    const e = LIBRARY.find((x) => x.id === id);
    if (!e) return ctx.notFound();
    const d: WorkflowDetail = {
      ...summary(e),
      script: `export const meta = {\n  name: '${e.id}',\n  description: '${e.description.replace(/'/g, "\\'")}',\n  phases: [${e.phases.map((p) => `{ title: '${p}' }`).join(', ')}],\n}\n\n// the script body runs in the hub's sandbox\n`,
    };
    return d;
  });
}

/**
 * The research session's subagent in the background (features/chat
 * RunningTasks.tsx): an explore agent reading the homelab's proxy config in
 * its own session. Its calls start and end on a timer with the tool.* and
 * message events a hub sends, so its row and the running tasks say what it
 * is doing now ("Searching for reverse_proxy"), until it answers and its
 * session goes idle.
 */
function registerProxySubagent(ctx: MockCtx, parentId: string, at: number): void {
  const id = 's_wfr_explore';
  if (ctx.db.sessions.has(id)) return;
  const model = 'anthropic/claude-haiku-5-5';
  const child: Session = {
    id,
    title: 'Read the homelab proxy config',
    agent: 'explore',
    model,
    mode: 'agent',
    permissionMode: 'default',
    cwd: '~/homelab',
    device: 'local',
    status: 'running',
    parentId,
    tags: [],
    pinned: false,
    archived: false,
    createdAt: at,
    updatedAt: Date.now(),
    stats: { messages: 3, inputTokens: 9_000, outputTokens: 300, cacheReadTokens: 0, costUsd: 0.01 },
  };
  ctx.db.sessions.set(id, child);
  let seq = 0;
  const msgs: Message[] = [];
  const add = (m: Pick<Message, 'role' | 'content'> & Partial<Message>, emit = true): Message => {
    seq++;
    const full: Message = { id: `m_wfx_${seq}`, sessionId: id, seq, kind: 'normal', createdAt: Date.now(), ...m };
    msgs.push(full);
    if (emit) ctx.emit({ type: 'message.created', message: structuredClone(full) });
    return full;
  };
  add({ role: 'user', content: [{ type: 'text', text: 'Find the reverse proxy config on the homelab and list each service it routes, with its port.' }] }, false);
  add({ role: 'assistant', model, agent: 'explore', content: [{ type: 'tool_use', id: 'tu_wfx_ls', name: 'LS', input: { path: '~/homelab' } }] }, false);
  add({ role: 'user', content: [{ type: 'tool_result', toolUseId: 'tu_wfx_ls', content: 'caddy/\ncompose/\nnotes.md\ntraefik/', meta: { durationMs: 20 } }] }, false);
  // the call it is making now
  const grep = add({ role: 'assistant', model, agent: 'explore', content: [{ type: 'tool_use', id: 'tu_wfx_grep', name: 'Grep', input: { pattern: 'reverse_proxy', path: '~/homelab' } }] }, false);
  ctx.db.messages.set(id, msgs);

  // a call: started, then its result when the next one starts
  let open: string | undefined = 'tu_wfx_grep';
  const results: Record<string, string> = {
    tu_wfx_grep: 'caddy/Caddyfile:2:  reverse_proxy 10.0.0.21:8096\ncaddy/Caddyfile:5:  reverse_proxy 10.0.0.22:8123\ncaddy/Caddyfile:8:  reverse_proxy 10.0.0.23:3000',
    tu_wfx_read: 'media.home.lan {\n  reverse_proxy 10.0.0.21:8096\n}\nha.home.lan {\n  reverse_proxy 10.0.0.22:8123\n}\ncode.home.lan {\n  reverse_proxy 10.0.0.23:3000\n}',
    tu_wfx_traefik: '(empty)',
  };
  const finish = () => {
    if (!open) return;
    const result = { type: 'tool_result' as const, toolUseId: open, content: results[open] ?? 'ok', meta: { durationMs: 900 } };
    ctx.emit({ type: 'tool.completed', sessionId: id, toolUseId: open, result });
    add({ role: 'user', content: [result] });
    open = undefined;
  };
  const start = (tid: string, name: string, input: Record<string, unknown>) => {
    finish();
    const m = add({ role: 'assistant', model, agent: 'explore', content: [{ type: 'tool_use', id: tid, name, input }] });
    ctx.emit({ type: 'tool.started', sessionId: id, messageId: m.id, toolUseId: tid, name, input });
    open = tid;
  };
  const steps: Array<() => void> = [
    // the call already in the transcript runs: the store hears it start
    () => ctx.emit({ type: 'tool.started', sessionId: id, messageId: grep.id, toolUseId: 'tu_wfx_grep', name: 'Grep', input: { pattern: 'reverse_proxy', path: '~/homelab' } }),
    () => {},
    () => {},
    () => {},
    () => start('tu_wfx_read', 'Read', { file_path: '~/homelab/caddy/Caddyfile' }),
    () => {},
    () => {},
    () => start('tu_wfx_traefik', 'LS', { path: '~/homelab/traefik' }),
    () => {},
    () => {},
    () => {
      finish();
      add({ role: 'assistant', model, agent: 'explore', stopReason: 'end_turn', content: [{ type: 'text', text: 'Caddy routes three services:\n- media.home.lan to 10.0.0.21:8096\n- ha.home.lan to 10.0.0.22:8123\n- code.home.lan to 10.0.0.23:3000\n\nThe traefik folder is empty since the move to Caddy.' }] });
      Object.assign(child, { status: 'idle', updatedAt: Date.now() });
      ctx.emit({ type: 'session.updated', session: structuredClone(child) });
    },
  ];
  const tick = () => {
    const step = steps.shift();
    if (!step) return;
    step();
    setTimeout(tick, 3_000);
  };
  setTimeout(tick, 1_500);
}
