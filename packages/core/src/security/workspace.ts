/**
 * The hunt folder a Security mode session starts in (docs/design/SECURITY-MODE.md
 * 1.1): scope.yaml, targets/ and playbook/, made on the session's device when
 * missing. Nothing that exists is overwritten. The scope.yaml it writes lists
 * no hosts, so the scope guard asks before every network call until the
 * owner fills it in (session/scope-guard.ts).
 */
import { join } from 'node:path';
import type { Machine } from '../machine/types';
import { parseScope } from './scope';

export const SECURITY_AGENT = 'security';

/** The scope.yaml a new hunt folder gets: valid, and empty of hosts. */
export function scopeTemplate(program: string): string {
  return [
    '# What this hunt may touch. The scope guard reads it before every network call;',
    '# a host not listed here is asked about, out_of_scope is refused.',
    `program: ${JSON.stringify(program || 'hunt')}`,
    '# Hosts or globs, never IP ranges: app.example.com, *.api.example.com',
    'in_scope: []',
    'out_of_scope: []',
    '# Docker networks of the lab (sec-lab-<target>), never IPs',
    'lab: []',
    'rate_limit_rps: 1',
    '',
  ].join('\n');
}

/** Make what is missing; returns the names made, in order. */
export async function ensureHuntFolder(m: Machine, cwd: string): Promise<string[]> {
  const made: string[] = [];
  if (!(await m.stat(cwd))) await m.mkdir(cwd);
  const scope = join(cwd, 'scope.yaml');
  if (!(await m.stat(scope))) {
    const text = scopeTemplate(cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'hunt');
    // the template must stay a file the guard accepts
    parseScope(text);
    await m.writeFile(scope, text);
    made.push('scope.yaml');
  }
  for (const dir of ['targets', 'playbook']) {
    if (await m.stat(join(cwd, dir))) continue;
    await m.mkdir(join(cwd, dir));
    made.push(`${dir}/`);
  }
  return made;
}
