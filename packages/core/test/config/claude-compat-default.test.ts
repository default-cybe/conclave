import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore, claudeHomeHasContent } from '../../src/config';

/** compat.claudeCode defaults on only when ~/.claude has something to load; a saved choice wins. */

const made: string[] = [];
const saved = process.env.CLAUDE_CONFIG_DIR;
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'conclave-ccdef-'));
  made.push(d);
  return d;
};
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('Claude Code compat default', () => {
  test('a missing or empty ~/.claude, or one with only empty folders and settings without hooks, loads nothing', () => {
    const c = dir();
    expect(claudeHomeHasContent(join(c, 'nope'))).toBe(false);
    mkdirSync(join(c, 'skills'));
    mkdirSync(join(c, 'projects', 'x'), { recursive: true });
    writeFileSync(join(c, 'settings.json'), JSON.stringify({ model: 'opus', hooks: {} }));
    expect(claudeHomeHasContent(c)).toBe(false);
  });

  test('skills, agents, commands, plugins or settings hooks count', () => {
    for (const d of ['skills', 'agents', 'commands', 'plugins']) {
      const c = dir();
      mkdirSync(join(c, d, 'x'), { recursive: true });
      expect(claudeHomeHasContent(c)).toBe(true);
    }
    const c = dir();
    writeFileSync(join(c, 'settings.json'), JSON.stringify({ hooks: { Stop: [] } }));
    expect(claudeHomeHasContent(c)).toBe(true);
  });

  test('a new hub follows ~/.claude once and saves it; later changes to ~/.claude do not flip it', () => {
    const claude = dir();
    process.env.CLAUDE_CONFIG_DIR = claude;
    const home = dir();
    const store = new ConfigStore(home);
    expect(store.get().compat.claudeCode).toBe(false);
    // a sync that writes skills into ~/.claude does not turn it on afterwards
    mkdirSync(join(claude, 'agents', 'a'), { recursive: true });
    expect(new ConfigStore(home).get().compat.claudeCode).toBe(false);
    store.update({ compat: { claudeCode: true } } as never);
    rmSync(join(claude, 'agents'), { recursive: true });
    expect(new ConfigStore(home).get().compat.claudeCode).toBe(true);
    mkdirSync(join(claude, 'skills', 's'), { recursive: true });
    expect(new ConfigStore(dir()).get().compat.claudeCode).toBe(true);
  });

  test('a hub that already has config.json without the key keeps the old default (on)', () => {
    process.env.CLAUDE_CONFIG_DIR = dir();
    const home = dir();
    writeFileSync(join(home, 'config.json'), JSON.stringify({ server: { token: 't' } }));
    expect(new ConfigStore(home).get().compat.claudeCode).toBe(true);
  });
});
