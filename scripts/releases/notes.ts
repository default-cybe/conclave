/**
 * Release notes from CHANGELOG.md (Keep a Changelog, `## [0.4.16] - 2026-10-24`
 * sections with `### What's new`, `### Changed`, `### Fixed`). Release calls it
 * for the tag and fails when the version has no section:
 *
 *   bun scripts/releases/notes.ts v0.4.16 [--file CHANGELOG.md]
 *
 * It prints the GitHub release body: each heading that has bullets, then the
 * install link. The function is exported for scripts/releases/notes.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const INSTALL_LINK = 'https://conclave.dymnitguys.com/#download';

export function releaseNotes(changelog: string, tag: string): string {
  const version = tag.replace(/^v/, '');
  const sections = new Map<string, string[]>();
  let cur: string[] | undefined;
  for (const line of changelog.split(/\r?\n/)) {
    const h = /^## \[([^\]]+)\]/.exec(line);
    if (h) sections.set(h[1], (cur = []));
    else if (/^## /.test(line)) cur = undefined;
    else cur?.push(line);
  }
  // a prerelease (v0.5.0-rc.1) may use its version's section
  const lines = sections.get(version) ?? sections.get(version.split('-')[0]);
  const parts: string[] = [];
  let heading = '';
  let items: string[] = [];
  const flush = () => {
    if (items.some((l) => /^\s*[-*] /.test(l))) parts.push(`${heading ? `${heading}\n` : ''}${items.join('\n').trim()}`);
    items = [];
  };
  for (const line of lines ?? []) {
    if (/^### /.test(line)) {
      flush();
      heading = line.trim();
    } else if (line.trim()) items.push(line.trimEnd());
  }
  flush();
  if (!parts.length) throw new Error(`CHANGELOG.md has no bullets for ${version}: add a "## [${version}] - YYYY-MM-DD" section.`);
  return `${parts.join('\n\n')}\n\n**Install:** ${INSTALL_LINK}\n`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--file');
  const file = i >= 0 ? args[i + 1] : join(resolve(import.meta.dir, '..', '..'), 'CHANGELOG.md');
  const tag = args.find((a, j) => !a.startsWith('--') && args[j - 1] !== '--file');
  try {
    if (!tag) throw new Error('Usage: bun scripts/releases/notes.ts <tag> [--file CHANGELOG.md]');
    process.stdout.write(releaseNotes(readFileSync(file, 'utf8'), tag));
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}
