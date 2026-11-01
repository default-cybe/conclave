/**
 * Launch forms: a workflow declares its args in meta.args (loadMeta checks
 * the shape), the library summary carries them as argsSchema, and saved
 * presets (per workflow, per account) round-trip through the store.
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestEngine } from '../engine/harness';
import { svcOf } from './helpers';
import { runAs } from '../../src/people/context';
import { WorkflowPreset } from '../../src/client/workflows';
import { loadMeta, summaryOf } from '../../src/workflows/registry';
import { WorkflowStore } from '../../src/workflows/store';

const DECLARED = `export const meta = {
  name: 'declared',
  description: 'declares args',
  args: { question: { type: 'string', description: 'what to ask' }, votes: { type: 'number' }, fast: { type: 'boolean' } },
}
return 'x'`;

test('meta.args loads with its shape checked, and reaches the summary as argsSchema', async () => {
  const { meta } = await loadMeta(DECLARED);
  expect(Object.keys(meta.args ?? {})).toEqual(['question', 'votes', 'fast']);
  const s = summaryOf({ id: 'declared', source: 'user', script: DECLARED, meta }, undefined);
  expect(s.argsSchema?.question).toEqual({ type: 'string', description: 'what to ask' });
  // a script with no args, or empty args, gets no schema: the JSON box stays
  const bare = await loadMeta(`export const meta = { name: 'bare', description: 'no args' }\nreturn 'x'`);
  expect(summaryOf({ id: 'bare', source: 'user', script: '', meta: bare.meta }, undefined).argsSchema).toBeUndefined();
  for (const bad of [
    `export const meta = { name: 'x', description: 'x', args: { q: { type: 'file' } } }`,
    `export const meta = { name: 'x', description: 'x', args: { q: 'string' } }`,
    `export const meta = { name: 'x', description: 'x', args: ['q'] }`,
    `export const meta = { name: 'x', description: 'x', args: { q: { type: 'string', description: 3 } } }`,
  ]) {
    await expect(loadMeta(bad)).rejects.toThrow(/meta\.args/);
  }
});

test('presets round-trip per workflow and account, replaced by name', () => {
  const store = new WorkflowStore(new Database(':memory:'));
  const p = (id: string, name: string): WorkflowPreset => ({ id, workflow: 'deep-research', name, args: { question: 'Caddy or Traefik' }, createdAt: 1 });
  store.savePreset({ ...p('wfp_1', 'front door'), accountId: 'owner' });
  store.savePreset({ ...p('wfp_2', 'front door'), accountId: 'owner' }); // same name replaces
  store.savePreset({ ...p('wfp_3', 'other'), accountId: 'owner' });
  store.savePreset({ ...p('wfp_4', 'front door'), accountId: 'member' }); // another account's own
  const owner = store.presets('deep-research', 'owner');
  expect(owner.map((x) => x.name)).toEqual(['front door', 'other']);
  expect(owner.find((x) => x.name === 'front door')?.id).toBe('wfp_2');
  expect(owner[0].args).toEqual({ question: 'Caddy or Traefik' });
  expect(store.presets('deep-research', 'member').map((x) => x.id)).toEqual(['wfp_4']);
  store.deletePreset('deep-research', 'wfp_2', 'owner');
  expect(store.presets('deep-research', 'owner').map((x) => x.name)).toEqual(['other']);
});

test('the service: an unknown workflow is a 404, a member cannot reach the owner library, each account sees its own presets', async () => {
  const t = await startTestEngine({ script: [[{ text: 'unused' }]] });
  try {
    const svc = svcOf(t.engine);
    mkdirSync(svc.registry.userDir, { recursive: true });
    writeFileSync(join(svc.registry.userDir, 'mine.js'), DECLARED);
    await expect(svc.listPresets('nope', 'owner')).rejects.toMatchObject({ status: 404 });
    await expect(svc.savePreset('nope', 'x', {}, 'owner')).rejects.toMatchObject({ status: 404 });
    await expect(svc.deletePreset('nope', 'wfp_1', 'owner')).rejects.toMatchObject({ status: 404 });
    // the owner's user workflow: the owner saves, a member gets the same 404 as for a missing one
    const p = await svc.savePreset('declared', ' front door ', { question: 'q' }, 'owner');
    expect(p.name).toBe('front door');
    for (const call of [async () => void (await svc.listPresets('declared', 'acc_m')), async () => void (await svc.savePreset('declared', 'x', {}, 'acc_m')), () => svc.deletePreset('declared', p.id, 'acc_m')])
      await expect(runAs('acc_m', call)).rejects.toMatchObject({ status: 404 });
    // a built-in one is open to the member, with its own presets only
    await svc.savePreset('deep-research', 'member one', null, 'acc_m');
    expect((await svc.listPresets('deep-research', 'acc_m')).map((x) => x.name)).toEqual(['member one']);
    expect(await svc.listPresets('deep-research', 'owner')).toEqual([]);
    await expect(svc.savePreset('declared', '  ', {}, 'owner')).rejects.toMatchObject({ status: 400 });
    await svc.deletePreset('declared', p.id, 'owner');
    expect(await svc.listPresets('declared', 'owner')).toEqual([]);
  } finally {
    await t.close();
  }
});
