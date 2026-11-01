/**
 * Mock routes. Skills agents wrote with SkillManage (core/extensions/learned.ts):
 * GET /api/skills/learned, GET, PATCH and DELETE /api/skills/learned/:name.
 *
 * The busy hub has four: two from coding sessions, one for one folder, and
 * one the skill review turned off. A first-run hub has none.
 */
import type { LearnedSkillDto } from '@conclave/core/client';
import type { MockCtx } from './index';

const DAY = 86_400_000;
const DIR = '/root/.conclave/learned-skills';
const day = (ago: number) => new Date(Date.now() - ago * DAY).toISOString().slice(0, 10);

function seed(): LearnedSkillDto[] {
  const skill = (s: Omit<LearnedSkillDto, 'path'>): LearnedSkillDto => ({ ...s, path: `${DIR}/${s.name}/SKILL.md` });
  return [
    skill({
      name: 'pbs-restore-test',
      description: 'Check that a PBS backup really restores, on a throwaway LXC. Use after changing backup jobs or retention.',
      enabled: true,
      sessionId: 's_backup',
      created: day(9),
      updated: day(2),
      lastUsedAt: Date.now() - 2 * DAY,
      uses: 3,
      body: [
        '# Test a PBS restore',
        '',
        '1. Pick the newest snapshot: `proxmox-backup-client snapshot list --repository root@pam@pbs:main`.',
        '2. Restore it into a throwaway LXC with id 999: `pct restore 999 <snapshot> --storage local-zfs`.',
        '3. Start it, then check the service: `pct exec 999 -- systemctl is-active <service>`.',
        '4. Destroy the LXC: `pct destroy 999 --purge`.',
        '',
        '## Pitfalls',
        '',
        '- The datastore must be mounted first, or the restore fails with "no such file".',
        '- Leave id 999 free; the restore refuses an id in use.',
      ].join('\n'),
    }),
    skill({
      name: 'jose-jwt-migration',
      description: 'Move a Node service from jsonwebtoken to jose without breaking old tokens.',
      enabled: true,
      sessionId: 's_auth',
      created: day(1),
      updated: day(1),
      body: '# jsonwebtoken to jose\n\n1. Find every `jwt.verify` and `jwt.sign` call.\n2. Replace them with `jwtVerify` and `SignJWT`, keeping the same algorithm and issuer.\n3. Run the auth tests, then sign in with a token made before the change.\n\n## Pitfalls\n\n- jose wants a `KeyLike`, not a string secret: wrap it with `new TextEncoder().encode(secret)`.\n',
    }),
    skill({
      name: 'mlfq-scheduler-tests',
      description: 'How the OS course grader runs the MLFQ scheduler tests, and what makes them flaky.',
      enabled: true,
      sessionId: 's_os',
      project: '~/uni/os/a3',
      created: day(4),
      updated: day(4),
      lastUsedAt: Date.now() - DAY,
      uses: 1,
      body: '# MLFQ tests\n\n1. `make clean && make qemu-nox` before the tests, or stale objects pass.\n2. Run `./grade-a3 --priority-boost` for the boost cases.\n',
    }),
    skill({
      name: 'wireguard-split-tunnel',
      description: 'Split tunnel the uni VPN with WireGuard so only the uni range goes through it.',
      enabled: false,
      disabledReason: 'merged into wireguard-uni-vpn',
      sessionId: 's_wg',
      created: day(70),
      updated: day(6),
      body: '# Split tunnel\n\nSet `AllowedIPs` to the uni ranges only, then `wg-quick down wg0 && wg-quick up wg0`.\n',
    }),
  ];
}

export function registerLearnedSkills(ctx: MockCtx) {
  const { on, db } = ctx;
  const skills = new Map<string, LearnedSkillDto>(ctx.FRESH ? [] : seed().map((s) => [s.name, s]));
  const dto = (s: LearnedSkillDto, withBody = false): LearnedSkillDto => {
    const { body, ...rest } = s;
    const title = s.sessionId ? db.sessions.get(s.sessionId)?.title : undefined;
    return { ...rest, ...(title ? { sessionTitle: title } : {}), ...(withBody ? { body } : {}) };
  };
  const get = (name: string) => skills.get(name) ?? ctx.fail(404, `no learned skill named ${name}`);

  on('GET', '/api/skills/learned', () => [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)).map((s) => dto(s)));

  on('GET', '/api/skills/learned/:name', ({ params }) => dto(get(params[0]), true));

  on('PATCH', '/api/skills/learned/:name', async ({ params, body }) => {
    const cur = get(params[0]);
    await ctx.sleep(250);
    const next = { ...cur };
    if (typeof body?.description === 'string') next.description = body.description.trim();
    if (typeof body?.body === 'string') {
      if (/!`[^`]+`/.test(body.body)) ctx.fail(400, 'Skills are Markdown only: write commands in a code block, not as !`command` lines, which would run when the skill is typed.');
      next.body = body.body;
    }
    if (body?.description !== undefined || body?.body !== undefined) next.updated = day(0);
    if (typeof body?.enabled === 'boolean') {
      next.enabled = body.enabled;
      if (body.enabled) delete next.disabledReason;
    }
    skills.set(cur.name, next);
    return dto(next, true);
  });

  on('DELETE', '/api/skills/learned/:name', async ({ params }) => {
    get(params[0]);
    await ctx.sleep(250);
    skills.delete(params[0]);
    return { ok: true };
  });
}
