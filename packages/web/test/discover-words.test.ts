/**
 * Discover's words (features/extensions/discover/words.ts): stars, dates,
 * missing needs, kinds and the folder a preview's files share.
 *
 *   bun test packages/web/test/discover-words.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { RECOMMENDED } from '@conclave/core/catalog/recommended';
import { KIND_ORDER, KIND_TAB, KIND_WORD, categoryWord, commonDir, isStale, licenseOpen, listWords, missingWords, shortSha, starsWords, underHome, updatedWords } from '../src/features/extensions/discover/words';

const NOW = new Date(2026, 9, 17, 15, 0).getTime();

describe('stars', () => {
  test('reads like GitHub', () => {
    expect(starsWords(165363)).toBe('165k stars');
    expect(starsWords(33672)).toBe('33.7k stars');
    expect(starsWords(4000)).toBe('4k stars');
    expect(starsWords(597)).toBe('597 stars');
    expect(starsWords(1)).toBe('1 star');
    expect(starsWords(1_250_000)).toBe('1.3M stars');
    expect(starsWords(undefined)).toBe('');
  });
});

describe('updated', () => {
  test('relative to today, by calendar day', () => {
    expect(updatedWords('2026-10-17', NOW)).toBe('updated today');
    expect(updatedWords('2026-10-16', NOW)).toBe('updated yesterday');
    expect(updatedWords('2026-10-14', NOW)).toBe('updated 3 days ago');
    expect(updatedWords('2026-09-20', NOW)).toBe('updated 4 weeks ago');
    expect(updatedWords('2026-04-20', NOW)).toBe('updated 6 months ago');
    expect(updatedWords('2025-06-20', NOW)).toBe('updated a year ago');
    expect(updatedWords(undefined, NOW)).toBe('');
    expect(updatedWords('not a date', NOW)).toBe('');
  });
  test('stale after 180 days without a commit', () => {
    expect(isStale('2025-06-20', NOW)).toBe(true);
    expect(isStale('2026-10-01', NOW)).toBe(false);
    expect(isStale(undefined, NOW)).toBe(false);
  });
});

describe('needs', () => {
  test('groups missing programs by where they must be', () => {
    expect(missingWords([])).toBe('');
    expect(missingWords([{ bin: 'uv', where: 'hub', why: '' }])).toBe('Needs uv on the hub.');
    expect(missingWords([{ bin: 'npx', where: 'hub', why: '' }, { bin: 'google-chrome', where: 'hub', why: '' }])).toBe('Needs npx and google-chrome on the hub.');
    expect(missingWords([{ bin: 'rtk', where: 'every-device', why: '' }, { bin: 'jq', where: 'hub', why: '' }], 'madx')).toBe('Needs rtk on every device and jq on madx.');
  });
  test('lists with a final "and"', () => {
    expect(listWords([])).toBe('');
    expect(listWords(['a'])).toBe('a');
    expect(listWords(['a', 'b', 'c'])).toBe('a, b and c');
  });
});

describe('files', () => {
  test('the folder every file shares', () => {
    expect(commonDir(['plugins/ponytail/a.json', 'plugins/ponytail/hooks/b.js'])).toBe('plugins/ponytail/');
    expect(commonDir(['~/.conclave/plugins/x/a', '~/.conclave/plugins/x/b/c'])).toBe('~/.conclave/plugins/x/');
    expect(commonDir(['skills/a/SKILL.md', 'agents/b.md'])).toBe('');
    expect(commonDir(['skills/a/SKILL.md'])).toBe('skills/a/');
    expect(commonDir([])).toBe('');
  });
  test('paths shown under ~/.conclave once', () => {
    expect(underHome('skills/a/')).toBe('~/.conclave/skills/a/');
    expect(underHome('~/.conclave/skills/a/')).toBe('~/.conclave/skills/a/');
    expect(underHome('/root/.conclave/x')).toBe('/root/.conclave/x');
  });
});

describe('labels', () => {
  test('every kind has a word and a tab', () => {
    for (const k of KIND_ORDER) {
      expect(KIND_WORD[k]).toBeTruthy();
      expect(KIND_TAB[k].href.startsWith('/')).toBe(true);
    }
  });
  test('every shipped category reads as words, with no dashes', () => {
    for (const it of RECOMMENDED) expect(categoryWord(it.category)).not.toContain('-');
    expect(categoryWord('github-git')).toBe('GitHub and git');
    expect(categoryWord('ctf')).toBe('CTF');
  });
  test('licenses that are not open source are flagged', () => {
    expect(licenseOpen('MIT')).toBe(true);
    expect(licenseOpen('Elastic-2.0')).toBe(false);
    expect(licenseOpen('Apache-2.0 (rtk-oss) or Apache-2.0 plus BUSL-1.1 (full)')).toBe(false);
    expect(licenseOpen(undefined)).toBeUndefined();
  });
  test('short shas are 7 characters', () => {
    expect(shortSha('16352ac229eb08a9598dcae48fe9f2b342567d86')).toBe('16352ac');
    expect(shortSha(undefined)).toBe('');
  });
});

describe('shipped data the rows rely on', () => {
  test('ponytail and caveman are the only picks and come first', () => {
    const musts = RECOMMENDED.filter((x) => x.must).map((x) => x.id);
    expect(musts).toEqual(['plugin:ponytail', 'plugin:caveman']);
    expect(RECOMMENDED[0].id).toBe('plugin:ponytail');
    expect(RECOMMENDED[1].id).toBe('plugin:caveman');
  });
  test('every item has a repo or a url to open', () => {
    for (const it of RECOMMENDED) expect(!!(it.repo || it.url)).toBe(true);
  });
});
