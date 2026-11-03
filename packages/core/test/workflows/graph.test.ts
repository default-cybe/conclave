/**
 * Workflow graphs (docs/design/VISUAL-PROGRAMMING.md 7): every built-in
 * parses to a sane graph, call-site lines map journal calls to nodes, a
 * literal edit changes only its own bytes, and Re-run this node replays
 * what does not depend on it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_WORKFLOWS } from '../../src/workflows/defaults';
import { applyEdit, GraphEditError, parseGraph } from '../../src/workflows/graph';
import { loadMeta } from '../../src/workflows/registry';
import { sha256 } from '../../src/workflows/store';
import { runAs } from '../../src/people/context';
import { nodeOf, nodeRuns, staleNodes } from '../../src/client/graph';
import type { WorkflowCall } from '../../src/client/workflows';
import { firstUserText, startTestEngine, until, type TestEngine } from '../engine/harness';
import { countRequests, noHarnesses, svcOf } from './helpers';

describe('parseGraph', () => {
  for (const d of DEFAULT_WORKFLOWS) {
    test(`${d.file} parses to a sane graph`, () => {
      const g = parseGraph(d.script);
      expect((g as { error?: string }).error).toBeUndefined();
      expect(g.name).toBe(d.file.replace(/\.js$/, ''));
      expect(g.nodes.length).toBeGreaterThanOrEqual(3);
      expect(g.nodes.length).toBeLessThanOrEqual(80);
      // ids unique, spans in order and inside the file
      expect(new Set(g.nodes.map((n) => n.id)).size).toBe(g.nodes.length);
      const lines = d.script.split('\n').length;
      for (const n of g.nodes) {
        expect(n.span.start).toBeGreaterThan(0);
        expect(n.span.end).toBeLessThanOrEqual(lines);
        expect(n.source.length).toBeGreaterThan(0);
        expect(d.script.includes(n.source)).toBe(true);
      }
      for (let i = 1; i < g.nodes.length; i++) expect(g.nodes[i].span.start).toBeGreaterThan(g.nodes[i - 1].span.end - 1);
      // every wire runs forward
      const at = new Map(g.nodes.map((n, i) => [n.id, i]));
      for (const e of g.edges) expect(at.get(e.from)!).toBeLessThan(at.get(e.to)!);
      // every agent() call in the file is either its own node or listed in a code node
      const agentCalls = (d.script.match(/(?<![.\w])agent\(/g) ?? []).length;
      const seen = g.nodes.filter((n) => n.kind === 'agent').length + g.nodes.reduce((k, n) => k + n.calls.filter((c) => c.name === 'agent').length, 0);
      expect(seen).toBe(agentCalls);
    });
  }

  test('top-level dialect statements become typed nodes; loops and helpers stay code nodes listing their calls', () => {
    const g = parseGraph(`export const meta = { name: 'x', description: 'x' }
phase('Plan')
const plan = await agent(['Plan it.', 'Carefully.'].join('\\n'), { label: 'plan', model: 'deep' })
const ok = await lib.runCheck('bun test')
await lib.approve(plan)
const [a, b] = await parallel([() => agent('one'), () => agent('two')])
for (const x of [1, 2]) {
  await agent('loop ' + x, { label: 'loop' })
}
const helper = async (y) => agent('help ' + y, { label: 'help' })
weird.stuff(1)
return { plan, ok, a, b }`);
    expect(g.nodes.map((n) => n.kind)).toEqual(['agent', 'check', 'approve', 'parallel', 'code', 'code', 'code', 'return']);
    const [plan, , , par, loop, helper] = g.nodes;
    expect(plan.label).toBe('plan');
    expect(plan.phase).toBe('Plan');
    expect(plan.opts?.model?.value).toBe('deep');
    expect(plan.promptParts?.map((p) => p.value)).toEqual(['Plan it.', 'Carefully.']);
    expect(par.calls.filter((c) => c.name === 'agent').length).toBe(2);
    expect(par.declares).toEqual(['a', 'b']);
    expect(loop.calls).toEqual([{ name: 'agent', line: 8, label: 'loop' }]);
    expect(helper.fn).toBe(true);
    expect(g.edges).toContainEqual({ from: plan.id, to: 'approve-1', name: 'plan' });
    expect(g.edges.filter((e) => e.to === 'return-1').map((e) => e.from).sort()).toEqual(['agent-1', 'check-1', 'parallel-1'].sort());
  });

  test('never throws: broken or odd scripts give a graph or an error, not an exception', () => {
    for (const s of ['', 'const x = `unterminated', '}}}{{{', 'return', '/* only a comment */', 'await agent(', "'use strict'\nconst a = 1"]) {
      expect(() => parseGraph(s)).not.toThrow();
    }
  });

  test('bad escapes in a string neither throw nor hang (an unclosed \\u{ used to loop forever)', () => {
    for (const s of ["const a = await agent('\\u{12')", "const a = await agent('\\u{110000}')", "const a = await agent('\\u{zz}', { label: '\\xZZ' })"]) {
      expect(parseGraph(s).nodes.map((n) => n.kind)).toEqual(['agent']);
    }
  });
});

describe('nodeOf', () => {
  const g = parseGraph(`export const meta = { name: 'x', description: 'x' }
const draft = await agent('draft', { label: 'draft' })
async function judge(t) {
  return agent('judge ' + t, { label: 'judge' })
}
const verdict = await judge(draft)
for (const k of [1, 2]) await agent('again ' + k, { label: 'again ' + k })
return verdict`);
  const call = (o: Partial<WorkflowCall>): WorkflowCall => ({ seq: 1, kind: 'agent', state: 'done', attempt: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, ...o });

  test('the innermost line inside a non-helper node wins; a helper call goes to its caller', () => {
    expect(nodeOf(call({ at: [2] }), g)?.id).toBe('agent-1');
    // helper's own line (4) first, then the caller's line (6)
    expect(nodeOf(call({ at: [4, 6] }), g)?.id).toBe('code-2');
    expect(nodeOf(call({ at: [7] }), g)?.id).toBe('code-3');
  });

  test('old calls with no lines fall back to the label', () => {
    expect(nodeOf(call({ label: 'draft' }), g)?.id).toBe('agent-1');
    expect(nodeOf(call({ label: 'nothing like it' }), g)).toBeUndefined();
  });

  test('nodeRuns rolls calls up per node: counts, cost, the worst state', () => {
    const { byNode, unplaced } = nodeRuns(g, [
      call({ seq: 1, at: [2], state: 'cached', costUsd: 0.5 }),
      call({ seq: 2, at: [4, 6], state: 'running', startedAt: 10 }),
      call({ seq: 3, at: [7], state: 'done', costUsd: 0.1 }),
      call({ seq: 4, at: [7], state: 'failed' }),
      call({ seq: 5, at: [99] }),
    ]);
    expect(byNode.get('agent-1')).toMatchObject({ state: 'cached', cached: 1, cachedCostUsd: 0.5, costUsd: 0 });
    expect(byNode.get('code-2')).toMatchObject({ state: 'running', running: 1, startedAt: 10 });
    expect(byNode.get('code-3')).toMatchObject({ state: 'failed', total: 2, done: 1, failed: 1, seqs: [3, 4] });
    expect(unplaced.map((c) => c.seq)).toEqual([5]);
  });

  test('staleNodes: a changed node and every node wired after it', () => {
    const after = parseGraph(g.nodes.length ? `export const meta = { name: 'x', description: 'x' }
const draft = await agent('draft v2', { label: 'draft' })
async function judge(t) {
  return agent('judge ' + t, { label: 'judge' })
}
const verdict = await judge(draft)
for (const k of [1, 2]) await agent('again ' + k, { label: 'again ' + k })
return verdict` : '');
    expect(staleNodes(g, after)).toEqual(['agent-1', 'code-2', 'return-1']);
  });
});

describe('applyEdit', () => {
  const script = DEFAULT_WORKFLOWS.find((d) => d.file === 'design-panel.js')!.script;
  const g = parseGraph(script);
  const agentNode = g.nodes.find((n) => n.kind === 'agent' && n.opts?.model && n.opts?.label)!;

  test('a model or label edit changes only that token; the rest of the file is byte-identical', async () => {
    for (const [field, value] of [
      ['model', 'fast'],
      ['label', "it's new"],
    ] as const) {
      const tok = agentNode.opts![field]!;
      const next = applyEdit(script, { nodeId: agentNode.id, field, value });
      const quoted = next.slice(tok.start, next.length - (script.length - tok.end));
      expect(next.slice(0, tok.start)).toBe(script.slice(0, tok.start));
      expect(next.slice(tok.start + quoted.length)).toBe(script.slice(tok.end));
      expect(quoted[0]).toBe(tok.quote!);
      expect(parseGraph(next).nodes.find((n) => n.id === agentNode.id)!.opts![field]!.value).toBe(value);
      expect(parseGraph(next).nodes.map((n) => n.id)).toEqual(g.nodes.map((n) => n.id));
      await loadMeta(next);
    }
  });

  test('a missing key is inserted after the options brace', async () => {
    const s = `export const meta = { name: 'x', description: 'x' }\nconst a = await agent('hi', { label: 'a' })\nreturn a`;
    const next = applyEdit(s, { nodeId: 'agent-1', field: 'model', value: 'deep' });
    expect(next).toBe(`export const meta = { name: 'x', description: 'x' }\nconst a = await agent('hi', { model: 'deep', label: 'a' })\nreturn a`);
    await loadMeta(next);
  });

  test('a prompt part edit keeps the quote style and escapes', () => {
    const s = `const a = await agent(['one', "two"].join(' '))`;
    expect(applyEdit(s, { nodeId: 'agent-1', field: 'prompt', value: 'say "hi"\nnow', part: 1 })).toBe(`const a = await agent(['one', "say \\"hi\\"\\nnow"].join(' '))`);
  });

  test('computed values, templates and non-agents are refused with the reason', () => {
    const s = 'const r = 1\nconst a = await agent(`x ${r}`, { label: "fix " + r })\nreturn a';
    expect(() => applyEdit(s, { nodeId: 'agent-1', field: 'prompt', value: 'y' })).toThrow(/template/);
    expect(() => applyEdit(s, { nodeId: 'agent-1', field: 'label', value: 'y' })).toThrow(/computed/);
    expect(() => applyEdit(s, { nodeId: 'return-1', field: 'model', value: 'deep' })).toThrow(GraphEditError);
    expect(() => applyEdit(s, { nodeId: 'agent-9', field: 'model', value: 'deep' })).toThrow(/not in the script/);
    expect(() => applyEdit(s, { nodeId: 'agent-1', field: 'model', value: 'rm -rf /' })).toThrow(/model/);
    expect(() => applyEdit(s, { nodeId: 'agent-1', field: 'agentType', value: 'ghost' }, { agentType: () => false })).toThrow(/not installed/);
    // the key in a form that is not a literal, or a spread that may set it: an inserted key would do nothing
    expect(() => applyEdit("await agent('x', { 'model': pick() })", { nodeId: 'agent-1', field: 'model', value: 'deep' })).toThrow(/computed/);
    expect(() => applyEdit("await agent('x', { model })", { nodeId: 'agent-1', field: 'model', value: 'deep' })).toThrow(/computed/);
    expect(() => applyEdit("await agent('x', { ...base })", { nodeId: 'agent-1', field: 'model', value: 'deep' })).toThrow(/spread/);
    // a nested key of the same name is not the option
    expect(applyEdit("await agent('x', { schema: { model: 1 } })", { nodeId: 'agent-1', field: 'model', value: 'deep' })).toBe("await agent('x', { model: 'deep', schema: { model: 1 } })");
  });
});

describe('the engine', () => {
  let t: TestEngine;
  beforeAll(async () => {
    t = await startTestEngine({
      script: [[{ text: 'fallback' }]],
      route: (body) => {
        const m = /say (\w+)/.exec(firstUserText(body));
        return m ? [{ text: m[1] }] : undefined;
      },
      approve: 'allow',
    });
    noHarnesses(t.engine);
  });
  afterAll(async () => t?.close());

  test('calls journal their call-site lines, through a helper and a parallel thunk', async () => {
    const svc = svcOf(t.engine);
    const s = await t.engine.createSession({ cwd: t.cwd });
    const script = `export const meta = { name: 'at', description: 'at' }
const a = await agent('say one')
async function h(x) {
  return agent('say ' + x)
}
const b = await h('two')
const [c] = await parallel([() => agent('say three')])
return [a, b, c]`;
    const r = await svc.wait((await svc.startRun({ script, sessionId: s.id })).id);
    expect(r.result).toEqual(['one', 'two', 'three']);
    const calls = svc.store.calls(r.id);
    expect(calls.map((c) => c.at)).toEqual([[2], [4, 6], [7]]);
    const g = parseGraph(script);
    expect(svc.run(r.id).calls.map((c) => nodeOf(c, g)?.id)).toEqual(['agent-1', 'code-2', 'parallel-1']);
  });

  test('Re-run this node: its calls and those whose prompts depend on it run, the rest replay; line changes alone still replay', async () => {
    const svc = svcOf(t.engine);
    const s = await t.engine.createSession({ cwd: t.cwd });
    const v1 = `export const meta = { name: 'rerun-node', description: 'r' }
const a = await agent('say alpha')
const b = await agent('say beta')
const c = await agent('say ' + b + 'x')
return [a, b, c]`;
    const r1 = await svc.wait((await svc.startRun({ script: v1, sessionId: s.id })).id);
    expect(r1.result).toEqual(['alpha', 'beta', 'betax']);
    // blank lines move every call site: the journal key ignores at, so all replay
    const moved = v1.replace("const a", '\n\nconst a');
    const step = await countRequests(t, async () => svc.wait((await svc.startRun({ script: moved, sessionId: s.id, resumeFromRunId: r1.id })).id));
    expect(step.requests).toBe(0);
    expect(svc.store.calls(step.value.id).map((c) => c.at)).toEqual([[4], [5], [6]]);

    // Re-run node b (call 2): b runs again; c's prompt is the same answer, so it replays; a replays
    const step2 = await countRequests(t, async () => {
      await svc.rerun(r1.id, { seqs: [2] });
      await until(() => svc.store.getRun(r1.id)?.status === 'done' && !svc.live.has(r1.id), 10_000);
      return svc.store.getRun(r1.id)!;
    });
    expect(step2.requests).toBe(1);
    expect(svc.store.calls(r1.id).map((c) => c.state)).toEqual(['cached', 'done', 'cached']);
    expect(() => svc.rerun(r1.id, { seqs: [] })).toThrow(/seqs/);
  });

  test('graph edits write back to a user workflow only, and a stale sha is 409', async () => {
    const svc = svcOf(t.engine);
    const dir = svc.registry.userDir;
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'edit-me.js');
    const script = `export const meta = { name: 'edit-me', description: 'e' }\nconst a = await agent('say hi', { label: 'hi', model: 'smart' })\nreturn a\n`;
    writeFileSync(path, script);
    const view = await svc.graph('edit-me');
    expect(view.editable).toBe(true);
    const res = await svc.editGraph('edit-me', { nodeId: 'agent-1', field: 'model', value: 'deep', baseSha: view.sha });
    expect(readFileSync(path, 'utf8')).toBe(script.replace("model: 'smart'", "model: 'deep'"));
    expect(res.sha).toBe(sha256(readFileSync(path, 'utf8')));
    expect(res.diff).toContain("+ const a = await agent('say hi', { label: 'hi', model: 'deep' })");
    await expect(svc.editGraph('edit-me', { nodeId: 'agent-1', field: 'model', value: 'fast', baseSha: view.sha })).rejects.toMatchObject({ status: 409 });
    await expect(svc.editGraph('edit-me', { nodeId: 'agent-1', field: 'agentType', value: 'no-such-agent', baseSha: res.sha })).rejects.toMatchObject({ status: 400 });

    // a built-in is read-only until copied
    const builtin = await svc.graph('fix-until-green');
    expect(builtin.editable).toBe(false);
    expect(builtin.readOnly).toMatch(/Copy/);
    await expect(svc.editGraph('fix-until-green', { nodeId: 'return-1', field: 'label', value: 'x', baseSha: builtin.sha })).rejects.toMatchObject({ status: 403 });
    const copy = await svc.copyWorkflow('fix-until-green');
    expect(copy.source).toBe('user');
    expect((await svc.graph('fix-until-green')).editable).toBe(true);
    await expect(svc.copyWorkflow('fix-until-green')).rejects.toMatchObject({ status: 409 });
  });

  test("a member never reads or edits the owner's workflow; a copy goes to their own folder", async () => {
    const svc = svcOf(t.engine);
    // edit-me is in the owner's folder (the test above)
    const owner = await svc.graph('edit-me');
    await runAs('acct_graph_m', async () => {
      await expect(svc.graph('edit-me')).rejects.toMatchObject({ status: 404 });
      await expect(svc.editGraph('edit-me', { nodeId: 'agent-1', field: 'model', value: 'fast', baseSha: owner.sha })).rejects.toMatchObject({ status: 404 });
      await expect(svc.copyWorkflow('edit-me')).rejects.toMatchObject({ status: 404 });
      // the owner's copy of fix-until-green is not theirs: they see the built-in and copy it to their account folder
      expect((await svc.graph('fix-until-green')).source).toBe('builtin');
      const copy = await svc.copyWorkflow('fix-until-green');
      expect(copy.source).toBe('account');
      expect(copy.path?.startsWith(svc.registry.accountDir('acct_graph_m'))).toBe(true);
    });
    expect(readFileSync(join(svc.registry.userDir, 'edit-me.js'), 'utf8')).toContain("model: 'deep'");
  });

  test("a project's workflow is not copied into the owner's trusted folder", async () => {
    const svc = svcOf(t.engine);
    const s = await t.engine.createSession({ cwd: t.cwd });
    mkdirSync(join(t.cwd, '.conclave', 'workflows'), { recursive: true });
    writeFileSync(join(t.cwd, '.conclave', 'workflows', 'repo-wf.js'), `export const meta = { name: 'repo-wf', description: 'r' }\nreturn 1\n`);
    const view = await svc.graph('repo-wf', s.id);
    expect(view.source).toBe('project');
    await expect(svc.copyWorkflow('repo-wf', s.id)).rejects.toMatchObject({ status: 400 });
  });
});
