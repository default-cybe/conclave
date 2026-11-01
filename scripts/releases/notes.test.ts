/**
 * Release notes from CHANGELOG.md: the tag's section, empty headings left out,
 * the install link at the end, and an error when the section is missing.
 *
 *   bun test scripts/releases
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INSTALL_LINK, releaseNotes } from './notes';

const LOG = `# Changelog

## [Unreleased]

### What's new
- Not out yet

## [0.5.0] - 2026-11-01

### What's new
- Members' own plans
  - each on their own proxy

### Changed

### Fixed
- The pairing code

## [0.4.0] - 2026-10-01

### Changed
- Old thing

See GitHub releases.
`;

describe('releaseNotes', () => {
  test('the tag section with non-empty headings, then the install link', () => {
    expect(releaseNotes(LOG, 'v0.5.0')).toBe(
      `### What's new\n- Members' own plans\n  - each on their own proxy\n\n### Fixed\n- The pairing code\n\n**Install:** ${INSTALL_LINK}\n`,
    );
  });

  test('stops at the next version', () => {
    const n = releaseNotes(LOG, 'v0.4.0');
    expect(n).toContain('- Old thing');
    expect(n).not.toContain('Members');
  });

  test('a prerelease uses its version section', () => {
    expect(releaseNotes(LOG, 'v0.5.0-rc.1')).toBe(releaseNotes(LOG, 'v0.5.0'));
  });

  test('fails without a section or without bullets', () => {
    expect(() => releaseNotes(LOG, 'v0.6.0')).toThrow('no bullets for 0.6.0');
    expect(() => releaseNotes('## [0.6.0] - 2026-12-01\n\n### Fixed\n', 'v0.6.0')).toThrow();
  });

  test('the committed CHANGELOG.md has 0.4.15', () => {
    const log = readFileSync(join(import.meta.dir, '..', '..', 'CHANGELOG.md'), 'utf8');
    expect(releaseNotes(log, 'v0.4.15')).toContain(INSTALL_LINK);
  });
});
