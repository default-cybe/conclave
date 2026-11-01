/**
 * "Install on the hub" in Discover (features/extensions/discover/hub-setup.ts):
 * when a card, a setup step or the Needs block gets the button, and the
 * words around it. The offers come from the hub's own planner over the
 * shipped list, as the hub would send them.
 *
 *   bun test packages/web/test/discover-hub-setup.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { RECOMMENDED, type CatalogItem } from '@conclave/core/catalog/recommended';
import { HUB_INSTALLERS, hubSetupOffer, type HubFacts, type HubSetupTarget } from '@conclave/core/catalog/hub-setup';
import type { CatalogItemDto, CatalogSetupResult, InstallPreview } from '@conclave/core/client';
import { INSTALL_LABEL, cardFix, confirmWords, resultWords, setupRequest, stepFix } from '../src/features/extensions/discover/hub-setup';

const item = (id: string) => RECOMMENDED.find((x) => x.id === id)!;
const facts = (missing: string[]): HubFacts => ({ has: (b) => !missing.includes(b), user: 'conclave', home: '/home/conclave', platform: 'linux' });

/** A card as the hub sends it, with these programs missing on the hub. */
function card(it: CatalogItem, missing: string[], shipped = true): CatalogItemDto {
  const miss = (it.needs ?? []).filter((n) => n.where === 'hub' && missing.includes(n.bin));
  return { ...it, ready: { ok: !miss.length, missing: miss, ...(miss.length ? { hubSetup: hubSetupOffer(it, { missing: true }, facts(missing), { shipped }) } : {}) } };
}

/** A preview step with the hub's offer for it. */
function step(it: CatalogItem, index: number, missing: string[], shipped = true): InstallPreview['steps'][number] {
  const s = (it.install.type === 'mcp' ? it.install.setup ?? [] : [])[index];
  const target: HubSetupTarget = { step: index, variant: 0 };
  return s.on === 'hub' && s.run ? { ...s, hub: hubSetupOffer(it, target, facts(missing), { shipped }) } : { ...s };
}

describe('the card', () => {
  test('missing programs the hub can install get the button, with uv first', () => {
    const fix = cardFix(card(item('mcp:serena'), ['uv', 'uvx', 'serena']));
    expect(fix?.kind).toBe('run');
    if (fix?.kind !== 'run') return;
    expect(fix.label).toBe(INSTALL_LABEL);
    expect(fix.offer.commands.map((c) => c.run)).toEqual([HUB_INSTALLERS.uv.run, 'uv tool install -p 3.13 serena-agent && serena init']);
    expect(setupRequest(fix.offer)).toEqual({ commands: fix.offer.commands.map((c) => c.run) });
    expect(cardFix(card(item('mcp:basic-memory'), ['uv', 'uvx']))?.kind).toBe('run');
  });

  test('root needs get no button: why in one line and the Debian command to copy', () => {
    const fix = cardFix(card(item('mcp:grafana'), ['docker']));
    expect(fix).toEqual({ kind: 'manual', line: 'docker needs root to install, so install it on the server by hand.', command: 'sudo apt-get install -y docker.io' });
    const chrome = cardFix(card(item('mcp:chrome-devtools'), ['google-chrome']));
    expect(chrome?.kind).toBe('manual');
    expect(chrome?.kind === 'manual' && chrome.command).toContain('google-chrome-stable_current_amd64.deb');
  });

  test('a result from outside the shipped list keeps its command to copy and never gets the button', () => {
    const fix = cardFix(card({ ...item('mcp:basic-memory'), id: 'reg:x', source: 'mcp-registry' }, ['uv', 'uvx'], false));
    expect(fix?.kind).toBe('manual');
    expect(fix?.kind === 'manual' && fix.line).toContain('only for items from its own list');
    expect(fix?.kind === 'manual' && fix.command).toBe(HUB_INSTALLERS.uv.run);
  });

  test('nothing when ready, when added, or when only a device lacks something', () => {
    expect(cardFix(card(item('mcp:serena'), []))).toBeNull();
    expect(cardFix({ ...card(item('mcp:serena'), ['serena']), installed: { id: 'mcp:serena', kind: 'mcp', ref: 'serena', href: '/x', matchedBy: 'record' } })).toBeNull();
    // python3 is needed on the device, so the card has nothing missing on the hub
    expect(cardFix(card(item('skill:document-skills'), ['python3']))).toBeNull();
  });
});

describe('setup steps in the preview', () => {
  test('a hub step of a shipped item gets the button, and sends its step and variant', () => {
    const fix = stepFix(step(item('mcp:semgrep'), 0, ['semgrep']), 'madx');
    expect(fix?.kind).toBe('run');
    if (fix?.kind !== 'run') return;
    expect(setupRequest(fix.offer)).toEqual({ step: 0, variant: 0, commands: ['uv tool install semgrep'] });
  });

  test('a device step keeps its copy and says where it runs', () => {
    expect(stepFix(step(item('mcp:ghidra'), 1, []), 'madx', 'arch-desktop')).toEqual({ kind: 'manual', line: 'This runs on arch-desktop, not on madx. Run it there.' });
    // a step with nothing to run gets nothing
    expect(stepFix(step(item('mcp:ghidra'), 0, []), 'madx')).toBeNull();
  });

  test('a step whose program needs root says so, with the Debian command instead of the step again', () => {
    const fix = stepFix(step(item('mcp:radare2'), 0, ['r2pm', 'r2mcp']), 'madx');
    expect(fix).toEqual({ kind: 'manual', line: 'It needs r2pm on the hub first.', command: 'sudo apt-get install -y radare2' });
  });

  test('a step from outside the shipped list never gets the button', () => {
    const fix = stepFix(step({ ...item('mcp:serena'), id: 'gh:oraios/serena', source: 'github' }, 0, ['serena'], false), 'madx');
    expect(fix?.kind).toBe('manual');
    expect(fix?.kind === 'manual' && fix.command).toBeUndefined();
  });

  test('a step that already ran says done', () => {
    expect(stepFix(step(item('mcp:semgrep'), 0, []), 'madx')).toEqual({ kind: 'done', line: 'Done: semgrep is on madx.' });
  });
});

describe('the words', () => {
  test('the confirm names the account, the folder and no sudo', () => {
    const offer = hubSetupOffer(item('mcp:serena'), { missing: true }, facts(['uv', 'uvx', 'serena']), { shipped: true });
    expect(confirmWords(offer, 'madx')).toBe('These 2 run on madx as conclave, in /home/conclave, one after another, and stop at the first that fails. Nothing runs with sudo.');
    const one = hubSetupOffer(item('mcp:semgrep'), { missing: true }, facts(['semgrep']), { shipped: true });
    expect(confirmWords(one, 'madx')).toBe('This runs on madx as conclave, in /home/conclave. Nothing runs with sudo.');
  });

  test('the result: ready, still missing, failed, stopped', () => {
    const base: CatalogSetupResult = { ok: true, exitCode: 0, ran: ['uv tool install semgrep'], user: 'conclave', tail: '', durationMs: 1, ready: { ok: true, missing: [] } };
    expect(resultWords(base, 'madx')).toEqual({ ok: true, text: 'Installed. Ready to add.' });
    const need = item('mcp:semgrep').needs![0];
    expect(resultWords({ ...base, ready: { ok: false, missing: [need] }, note: 'semgrep landed in ~/.local/bin, which is not on the hub\'s PATH.' }, 'madx')).toEqual({ ok: false, text: 'It ran, but semgrep is still missing on madx. semgrep landed in ~/.local/bin, which is not on the hub\'s PATH.' });
    expect(resultWords({ ...base, ok: false, exitCode: 2 }, 'madx')).toEqual({ ok: false, text: 'Failed with exit code 2.' });
    expect(resultWords({ ...base, ok: false, exitCode: 1, ran: ['curl x', 'uv tool install semgrep'] }, 'madx').text).toBe('Failed at uv tool install with exit code 1.');
    expect(resultWords({ ...base, ok: false, exitCode: null, timedOut: true }, 'madx').text).toBe('Stopped after 10 minutes.');
  });
});
