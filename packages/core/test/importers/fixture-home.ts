/**
 * Copies the fixture home (~/.claude and ~/.codex) into a temp dir and sets
 * file mtimes, since git does not keep them.
 */
import { cpSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FIXTURE_HOME = join(import.meta.dir, 'fixtures', 'home');

export const IDS = {
  claudeA: '11111111-1111-4111-8111-111111111111',
  claudeB: '22222222-2222-4222-8222-222222222222',
  codexC: '33333333-3333-4333-8333-333333333333',
  codexD: '44444444-4444-4444-8444-444444444444',
};

export const PATHS = {
  claudeA: `.claude/projects/-home-u-proj/${IDS.claudeA}.jsonl`,
  claudeB: `.claude/projects/-home-u-other/${IDS.claudeB}.jsonl`,
  claudeSub: `.claude/projects/-home-u-other/${IDS.claudeB}/subagents/agent-abc.jsonl`,
  codexC: `.codex/sessions/2025/10/02/rollout-2025-10-02T08-00-00-${IDS.codexC}.jsonl`,
  codexD: `.codex/sessions/2025/09/30/rollout-2025-09-30T07-00-00-${IDS.codexD}.jsonl`,
};

const MTIMES: Record<keyof typeof PATHS, string> = {
  claudeA: '2025-10-01T10:02:00Z',
  claudeB: '2025-10-03T12:00:05Z',
  claudeSub: '2025-10-03T12:00:04Z',
  codexC: '2025-10-02T08:01:05Z',
  codexD: '2025-09-30T07:00:03Z',
};

const made: string[] = [];
// tests that do not call cleanupFixtureHomes (the usage readers) still leave nothing behind
process.on('exit', () => cleanupFixtureHomes());

/** Remove every fixture home this process made (call from afterAll). */
export function cleanupFixtureHomes(): void {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function fixtureHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'conclave-home-'));
  made.push(home);
  cpSync(FIXTURE_HOME, home, { recursive: true });
  for (const [k, rel] of Object.entries(PATHS)) {
    const t = new Date(MTIMES[k as keyof typeof PATHS]);
    utimesSync(join(home, rel), t, t);
  }
  return home;
}
