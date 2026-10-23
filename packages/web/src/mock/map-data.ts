/**
 * The Map's mock hub (docs/DESIGN.md 29): three projects on three devices,
 * the chats, about fifteen agents with subagents and one workflow run. Six
 * run, one waits on you, one failed, one is paused on a limit.
 *
 * Pure and free of web imports, so the screenshot script can print it with
 * Bun: `bun -e "console.log(JSON.stringify((await import('./map-data.ts')).mapFixture(Date.now())))"`.
 */
import type { MapNode, MapSnapshot, MapTool, MapUsage } from '@conclave/core/client';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Ids shaped like a hub's own (prefix, time, random), so the labels show a real short id. */
export const MAP_IDS = {
  auth: 'ses_mgwk9p34y6n3wd25rq4',
  explore: 'ses_mgwf5zr37e3p3e2z8iq',
  paths: 'ses_mgw9y7jzb6cn6z43dvy',
  review: 'ses_mgwrkttnjfbf5jxvlsi',
  bench: 'ses_mgw47wqal9vq24zklmv',
  correct: 'ses_mgwt45hu43jsiom1tma',
  security: 'ses_mgw7v3di8fppv5aspzh',
  tests: 'ses_mgw8rzhqmoe95b9ee0v',
  docs: 'ses_mgwbgi09qynk8w3tzpp',
  refute: 'ses_mgwpp6up3c4dsa7l360',
  login: 'ses_mgw9y6n14do9gmnu77v',
  push: 'ses_mgwtuuj596lguax1dxn',
  e2e: 'ses_mgw9y1xj5gxnameyywl',
  bundle: 'ses_mgwecfpecxvm11hugcm',
  backup: 'ses_mgwsmn5e6eucldu0um5',
  certs: 'ses_mgw7ocubrl5ptp5aa81',
  week: 'ses_mgw9t9um9zz8106x8rc',
  proxy: 'ses_mgwd1gdiwfkgyq83mtx',
  run: 'wfr_mgwqw8y9xw1sb09b9u7',
} as const;
const I = MAP_IDS;

/** A stable pseudo random number from a string, 0 to 1. */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10_000) / 10_000;
}

const usage = (inputTokens: number, outputTokens: number, cacheReadTokens: number, costUsd: number, cacheWriteTokens = Math.round(cacheReadTokens / 9)): MapUsage => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd });

const tool = (now: number, name: string, target: string, agoS: number, durationMs?: number, error?: boolean): MapTool => ({
  id: `tu_${name}_${target}_${agoS}`.replace(/[^\w]/g, '_'),
  name,
  target,
  startedAt: now - agoS * 1000,
  ...(durationMs !== undefined ? { durationMs } : {}),
  ...(error ? { error: true } : {}),
});

export function mapFixture(now: number): MapSnapshot {
  const n = (x: Partial<MapNode> & Pick<MapNode, 'id' | 'kind' | 'title' | 'state' | 'group' | 'device'>, startedMin: number, lastS: number): MapNode => ({
    tools: [],
    usage: usage(0, 0, 0, 0),
    tokensPerMin: 0,
    rate: 0,
    startedAt: now - startedMin * MIN,
    lastActivityAt: now - lastS * 1000,
    ...x,
  });
  const CONCLAVE = 'p:prj_conclave@arch-desktop';
  const FERNWAY = 'p:prj_fernway@macbook';
  const HOMELAB = 'p:prj_homelab@pve';

  const nodes: MapNode[] = [
    // conclave on arch-desktop: the jose move with two explorers, a review, a benchmark on a limit, and a workflow
    n(
      {
        id: I.auth,
        kind: 'session',
        title: 'Move auth middleware to jose',
        state: 'running',
        agent: 'coder',
        model: 'anthropic/claude-sonnet-5-5',
        device: 'arch-desktop',
        cwd: '~/code/conclave',
        group: CONCLAVE,
        tool: tool(now, 'Bash', 'bun test packages/server', 4),
        tools: [tool(now, 'Edit', 'auth.ts', 41, 140), tool(now, 'Read', 'pair.ts', 63, 220), tool(now, 'Grep', 'jwtVerify', 95, 1_800), tool(now, 'Edit', 'auth.ts', 160, 120), tool(now, 'Read', 'auth.ts', 212, 310)],
        usage: usage(184_200, 9_400, 1_510_000, 0.71),
        tokensPerMin: 1_920,
        rate: 34,
      },
      38,
      2,
    ),
    n(
      {
        id: I.explore,
        kind: 'subagent',
        title: 'Find all JWT usages',
        state: 'done',
        agent: 'explore',
        model: 'anthropic/claude-haiku-5-5',
        device: 'arch-desktop',
        cwd: '~/code/conclave',
        group: CONCLAVE,
        parentId: I.auth,
        tools: [tool(now, 'Grep', 'jwtVerify|jose', 2_050, 900), tool(now, 'Read', 'routes.ts', 2_080, 240)],
        usage: usage(31_000, 900, 220_000, 0.02),
        endedAt: now - 34 * MIN,
      },
      35,
      34 * 60,
    ),
    n(
      {
        id: I.paths,
        kind: 'subagent',
        title: 'Check jose import paths',
        state: 'running',
        agent: 'explore',
        model: 'anthropic/claude-haiku-5-5',
        device: 'arch-desktop',
        cwd: '~/code/conclave',
        group: CONCLAVE,
        parentId: I.auth,
        tool: tool(now, 'Glob', 'packages/**/package.json', 2),
        tools: [tool(now, 'Read', 'tsconfig.base.json', 14, 90)],
        usage: usage(12_400, 1_100, 48_000, 0.01),
        tokensPerMin: 980,
        rate: 21,
      },
      3,
      2,
    ),
    n(
      {
        id: I.review,
        kind: 'session',
        title: 'Review the jose diff',
        state: 'idle',
        agent: 'reviewer',
        model: 'openai/gpt-5.5',
        device: 'arch-desktop',
        cwd: '~/code/conclave',
        group: CONCLAVE,
        tools: [tool(now, 'Read', 'auth.ts', 52 * 60, 180)],
        usage: usage(41_000, 2_600, 0, 0.09),
        endedAt: now - 50 * MIN,
      },
      55,
      50 * 60,
    ),
    n(
      {
        id: I.bench,
        kind: 'session',
        title: 'Benchmark the harness, run 5',
        state: 'paused',
        agent: 'tester',
        model: 'claude-code/opus',
        device: 'arch-desktop',
        cwd: '~/code/conclave',
        group: CONCLAVE,
        resumeAt: now + 83 * MIN,
        tools: [tool(now, 'Bash', 'bun bench/run.ts --arm b', 40 * 60, 312_000)],
        usage: usage(96_000, 7_200, 640_000, 1.84),
      },
      150,
      37 * 60,
    ),
    n(
      {
        id: `wf:${I.run}`,
        kind: 'workflow',
        title: 'review-changes',
        state: 'running',
        agent: 'workflow',
        device: 'arch-desktop',
        cwd: '~/code/conclave',
        group: CONCLAVE,
        runId: I.run,
        usage: usage(162_000, 14_900, 920_000, 0.88),
        tokensPerMin: 2_520,
      },
      12,
      1,
    ),
    ...(
      [
        [I.correct, 'correctness lens', 'running', 'Read', 'auth.ts', 26, 1_440],
        [I.security, 'security lens', 'running', 'Grep', 'alg.*none', 17, 1_080],
        [I.tests, 'tests lens', 'done', 'Bash', 'bun test packages/server', 0, 0],
        [I.docs, 'docs lens', 'done', 'Read', 'DESIGN.md', 0, 0],
        [I.refute, 'refuter, finding 2', 'done', 'Read', 'pair.ts', 0, 0],
      ] as const
    ).map(([id, title, state, toolName, target, rate, tpm], i) =>
      n(
        {
          id,
          kind: 'agent',
          title,
          state,
          agent: i === 4 ? 'verifier' : 'reviewer',
          model: i === 4 ? 'anthropic/claude-opus-5-5' : 'anthropic/claude-sonnet-5-5',
          device: 'arch-desktop',
          cwd: '~/code/conclave',
          group: CONCLAVE,
          parentId: `wf:${I.run}`,
          runId: I.run,
          ...(state === 'running' ? { tool: tool(now, toolName, target, 3 + i * 2) } : { endedAt: now - (4 + i) * MIN }),
          tools: [tool(now, toolName, target, 90 + i * 30, 400 + i * 120)],
          usage: usage(30_000 + i * 4_000, 2_400 + i * 300, 160_000, 0.16 + i * 0.02),
          tokensPerMin: tpm,
          rate,
        },
        11 - i,
        state === 'running' ? 1 : (4 + i) * 60,
      ),
    ),

    // fernway-web on the MacBook: the login fix, a push that waits on you, e2e tests, a failed audit
    n(
      {
        id: I.login,
        kind: 'session',
        title: 'Fix login redirect',
        state: 'running',
        agent: 'coder',
        model: 'anthropic/claude-opus-5-5',
        device: 'macbook',
        cwd: '~/Developer/fernway-web',
        group: FERNWAY,
        tool: tool(now, 'Edit', 'redirect.ts', 1),
        tools: [tool(now, 'Read', 'redirect.ts', 9, 60), tool(now, 'Read', 'login-form.ts', 22, 70), tool(now, 'Grep', 'afterLogin', 31, 640)],
        usage: usage(58_000, 4_100, 310_000, 0.62),
        tokensPerMin: 2_700,
        rate: 46,
      },
      9,
      1,
    ),
    n(
      {
        id: I.push,
        kind: 'session',
        title: 'Push the login fix',
        state: 'waiting',
        waitingOn: 'approval',
        agent: 'coder',
        model: 'anthropic/claude-sonnet-5-5',
        device: 'macbook',
        cwd: '~/Developer/fernway-web',
        group: FERNWAY,
        tool: tool(now, 'Bash', 'git push origin fix/login', 128),
        tools: [tool(now, 'Bash', 'git log --oneline -3', 140, 210)],
        usage: usage(19_000, 600, 41_000, 0.06),
      },
      4,
      128,
    ),
    n(
      {
        id: I.e2e,
        kind: 'session',
        title: 'Write e2e tests for checkout',
        state: 'idle',
        agent: 'tester',
        model: 'anthropic/claude-sonnet-5-5',
        device: 'macbook',
        cwd: '~/Developer/fernway-web',
        group: FERNWAY,
        tools: [tool(now, 'Bash', 'bunx playwright test', 3 * 3600, 48_000), tool(now, 'Write', 'checkout.spec.ts', 3 * 3600 + 90, 30)],
        usage: usage(88_000, 6_400, 720_000, 0.48),
        endedAt: now - 3 * HOUR,
      },
      4 * 60,
      3 * 3600,
    ),
    n(
      {
        id: I.bundle,
        kind: 'session',
        title: 'Audit the bundle size',
        state: 'failed',
        agent: 'coder',
        model: 'zai/glm-5',
        device: 'macbook',
        cwd: '~/Developer/fernway-web',
        group: FERNWAY,
        error: 'vite build exited with code 1: Could not resolve "./charts"',
        tools: [tool(now, 'Bash', 'bunx vite build --mode analyze', 47 * 60, 9_400, true)],
        usage: usage(22_000, 1_300, 0, 0.03),
        endedAt: now - 47 * MIN,
      },
      58,
      47 * 60,
    ),

    // homelab scripts on pve: the backup check through Claude Code, and a cert rotation that finished
    n(
      {
        id: I.backup,
        kind: 'session',
        title: 'Verify PBS backups for all LXCs',
        state: 'running',
        agent: 'sysadmin',
        model: 'claude-code/sonnet',
        device: 'pve',
        cwd: '/root/scripts',
        group: HOMELAB,
        tool: tool(now, 'Bash', 'proxmox-backup-client list', 6),
        tools: [tool(now, 'Bash', 'pct list', 18, 900), tool(now, 'Read', 'backup.sh', 25, 40)],
        usage: usage(36_000, 2_200, 140_000, 0.21),
        tokensPerMin: 640,
        rate: 11,
      },
      52,
      3,
    ),
    n(
      {
        id: I.certs,
        kind: 'session',
        title: 'Rotate the Caddy certificates',
        state: 'done',
        agent: 'sysadmin',
        model: 'anthropic/claude-sonnet-5-5',
        device: 'pve',
        cwd: '/root/scripts',
        group: HOMELAB,
        tools: [tool(now, 'Bash', 'systemctl reload caddy', 6 * 3600, 1_200)],
        usage: usage(14_000, 900, 61_000, 0.05),
        endedAt: now - 6 * HOUR,
      },
      7 * 60,
      6 * 3600,
    ),

    // the chats
    n({ id: I.week, kind: 'chat', title: 'Plan the week', state: 'idle', agent: 'chat', model: 'anthropic/claude-sonnet-5-5', device: 'local', group: 'chats', usage: usage(6_200, 900, 12_000, 0.03), endedAt: now - 2 * HOUR }, 2.5 * 60, 2 * 3600),
    n({ id: I.proxy, kind: 'chat', title: 'Caddy or Traefik for the homelab', state: 'idle', agent: 'chat', model: 'openai/gpt-5.5', device: 'local', group: 'chats', tools: [tool(now, 'WebSearch', 'caddy vs traefik 2026', 5 * 3600, 2_100)], usage: usage(22_000, 6_100, 0, 0.19), endedAt: now - 5 * HOUR }, 5.5 * 60, 5 * 3600),
  ];

  const counted = nodes.filter((x) => x.kind !== 'workflow');
  const running = counted.filter((x) => x.state === 'running').length;
  const waiting = counted.filter((x) => x.state === 'waiting').length;
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return {
    at: now,
    live: true,
    from: now - 24 * HOUR,
    hub: { name: 'madx', state: waiting ? 'waiting' : running ? 'running' : 'idle' },
    devices: [
      { id: 'local', name: 'madx', online: true },
      { id: 'arch-desktop', name: 'arch-desktop', online: true },
      { id: 'macbook', name: 'MacBook', online: true },
      { id: 'pve', name: 'pve', online: true },
      { id: 'kali-vm', name: 'kali-vm', online: false },
    ],
    groups: [
      { id: CONCLAVE, kind: 'project', name: 'conclave', device: 'arch-desktop', projectId: 'prj_conclave', path: '~/code/conclave' },
      { id: FERNWAY, kind: 'project', name: 'fernway-web', device: 'macbook', projectId: 'prj_fernway', path: '~/Developer/fernway-web' },
      { id: HOMELAB, kind: 'project', name: 'homelab-scripts', device: 'pve', projectId: 'prj_homelab', path: '/root/scripts' },
      { id: 'chats', kind: 'chats', name: 'Chats', device: 'local' },
    ],
    nodes,
    totals: { running, waiting, today: { from: midnight.getTime(), tokens: 3_412_000, costUsd: 8.12 } },
  };
}

/**
 * The same hub at an earlier time, for the replay scrubber: what had not
 * started is gone, what ended later was still running, and usage scales
 * with the time it had.
 */
export function mapFixtureAt(now: number, at: number): MapSnapshot {
  const snap = mapFixture(now);
  const nodes: MapNode[] = [];
  for (const x of snap.nodes) {
    if (x.startedAt > at) continue;
    const end = x.endedAt ?? (x.state === 'running' || x.state === 'waiting' ? undefined : x.lastActivityAt);
    const share = Math.max(0.05, Math.min(1, (at - x.startedAt) / Math.max(1, (end ?? now) - x.startedAt)));
    const scale = (u: MapUsage): MapUsage => ({ inputTokens: Math.round(u.inputTokens * share), outputTokens: Math.round(u.outputTokens * share), cacheReadTokens: Math.round(u.cacheReadTokens * share), cacheWriteTokens: Math.round(u.cacheWriteTokens * share), costUsd: u.costUsd * share });
    const working = end === undefined || end > at;
    const rate = working ? 8 + hash01(x.id) * 30 : 0;
    nodes.push({
      ...x,
      state: working ? (x.kind === 'workflow' ? 'running' : x.state === 'waiting' && at > now - 3 * MIN ? 'waiting' : 'running') : x.state,
      ...(working ? {} : { tool: undefined }),
      tools: x.tools.filter((t) => t.startedAt <= at),
      lastActivityAt: Math.min(x.lastActivityAt, at),
      usage: scale(x.usage),
      rate: x.kind === 'workflow' ? 0 : rate,
      tokensPerMin: Math.round(rate * 60),
    });
  }
  const ids = new Set(nodes.map((x) => x.id));
  for (const x of nodes) if (x.parentId && !ids.has(x.parentId)) delete x.parentId;
  const counted = nodes.filter((x) => x.kind !== 'workflow');
  const running = counted.filter((x) => x.state === 'running').length;
  const waiting = counted.filter((x) => x.state === 'waiting').length;
  return {
    ...snap,
    at,
    live: false,
    hub: { ...snap.hub, state: waiting ? 'waiting' : running ? 'running' : 'idle' },
    devices: snap.devices.map(({ online: _online, ...d }) => d),
    groups: snap.groups.filter((g) => nodes.some((x) => x.group === g.id)),
    nodes,
    totals: { running, waiting, today: { ...snap.totals.today, tokens: Math.round(snap.totals.today.tokens * Math.max(0.1, (at - snap.totals.today.from) / Math.max(1, now - snap.totals.today.from))), costUsd: snap.totals.today.costUsd * Math.max(0.1, (at - snap.totals.today.from) / Math.max(1, now - snap.totals.today.from)) } },
  };
}
