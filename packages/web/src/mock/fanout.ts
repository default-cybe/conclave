/**
 * A session with a fan-out of four background subagents and a workflow, as
 * a real session leaves them: four Task calls, a TaskWait, four result
 * notices (two done, one failed, one stopped at a usage limit), the report
 * carrier, a TaskContinue that runs one again (round 2) and its notice after
 * prose, then a Workflow with three phases and a WorkflowStatus call. The
 * fan-out card (features/chat/FanOutCard.tsx) draws all of it as two cards.
 * Seeded into the mock by workflows.ts and read by test/fan-out.test.tsx.
 */
import type { Message, Session } from '@conclave/core/types';
import type { WorkflowCall, WorkflowRun } from '@conclave/core/client';

export const FANOUT_SESSION = 's_fanout';

const KIDS = [
  { id: 'ses_0mvCore', label: 'Audit core for unsafe parsing', agent: 'explore', model: 'anthropic/claude-haiku-5-5', state: 'completed', took: 132_000, report: 'No unsafe deserialization in core.\n\n- `JSON.parse` calls all go through `safeParse` (packages/core/src/util/json.ts:12).\n- The YAML loader uses the `CORE_SCHEMA`, so no custom tags.' },
  { id: 'ses_0mvServer', label: 'Audit server request bodies', agent: 'explore', model: 'anthropic/claude-haiku-5-5', state: 'completed', took: 171_000, report: 'One risk: `/api/import` passes the uploaded file to `structuredClone` after `JSON.parse` with no size cap.\n\nSuggest a 10 MB limit in `packages/server/src/routes/import.ts:48`.' },
  { id: 'ses_0mvWeb', label: 'Audit web markdown rendering', agent: 'security', model: 'openai/gpt-5.5', state: 'failed', took: 64_000, report: 'Error: the subagent could not read packages/web/src/features/chat/Markdown.tsx (permission denied).' },
  { id: 'ses_0mvCli', label: 'Audit cli config loading', agent: 'explore', model: 'google/gemini-3-pro', state: 'limited', took: 190_000, report: '(the subagent produced no final answer)' },
] as const;

export function fanOutFixture(now = Date.now()) {
  const S = FANOUT_SESSION;
  const t0 = now - 14 * 60_000;
  let seq = 0;
  const m = (role: Message['role'], content: Message['content'], at: number, more: Partial<Message> = {}): Message => ({ id: `m_fo_${++seq}`, sessionId: S, seq, role, kind: 'normal', createdAt: t0 + at, content, ...more }) as Message;
  const notice = (k: (typeof KIDS)[number], at: number): Message =>
    m('assistant', [{ type: 'text', text: `Background task ${k.state === 'completed' ? 'finished' : k.state === 'limited' ? 'stopped at a usage limit' : 'failed'}: ${k.label}` }], at, {
      kind: 'notice',
      meta: { level: k.state === 'completed' ? 'info' : 'warning', kind: 'agent-result', agentResult: { type: 'subagent', id: k.id, label: k.label, agent: k.agent, state: k.state } },
    });
  const block = (k: (typeof KIDS)[number], report: string, state: string = k.state) => `<subagent_result session="${k.id}" agent="${k.agent}" state="${state}" description="${k.label}">\n${report}\n</subagent_result>`;
  const reminder = (blocks: string[], at: number) => m('user', [{ type: 'text', text: `<system-reminder>\nBackground subagents you started have finished. Their final reports:\n${blocks.join('\n')}\n</system-reminder>` }], at, { meta: { auto: true, kind: 'agent-result' } });

  const messages: Message[] = [
    m('user', [{ type: 'text', text: 'Audit the four packages for unsafe deserialization. Split it up.' }], 0),
    m(
      'assistant',
      [
        { type: 'text', text: 'Four packages, four subagents in the background, one each.' },
        ...KIDS.map((k, i) => ({ type: 'tool_use' as const, id: `tu_fo_${i}`, name: 'Task', input: { description: k.label, subagent_type: k.agent, prompt: `Audit ${k.label.split(' ')[1]} for unsafe deserialization. Report file and line.`, run_in_background: true } })),
      ],
      5_000,
      { model: 'anthropic/claude-opus-5-5' },
    ),
    m('user', KIDS.map((k, i) => ({ type: 'tool_result' as const, toolUseId: `tu_fo_${i}`, content: `Subagent "${k.agent}" started in the background (session ${k.id}). You will be notified when it finishes.`, meta: { sessionId: k.id, agent: k.agent, background: true } })), 6_000),
    m('assistant', [{ type: 'tool_use', id: 'tu_fo_wait', name: 'TaskWait', input: { ids: KIDS.map((k) => k.id), timeoutSec: 300 } }], 8_000),
    m('user', [{ type: 'tool_result', toolUseId: 'tu_fo_wait', content: KIDS.map((k) => `${k.id} ${k.agent} ${k.state}`).join('\n') }], 200_000),
    ...KIDS.map((k, i) => notice(k, 6_000 + k.took + i)),
    reminder(KIDS.map((k) => block(k, k.report)), 201_000),
    m(
      'assistant',
      [
        { type: 'text', text: 'Two came back clean, the web audit failed on a permission and the cli one hit a usage limit. Asking the server auditor for the exact fix.' },
        { type: 'tool_use', id: 'tu_fo_cont', name: 'TaskContinue', input: { id: KIDS[1].id, text: 'Write the exact patch for the size cap.' } },
      ],
      205_000,
      { model: 'anthropic/claude-opus-5-5' },
    ),
    m('user', [{ type: 'tool_result', toolUseId: 'tu_fo_cont', content: `Continued ${KIDS[1].id}.` }], 206_000),
    m('assistant', [{ type: 'text', text: 'While that runs, a deep review of the import path.' }, { type: 'tool_use', id: 'tu_fo_wf', name: 'Workflow', input: { name: 'review-changes', estimate: { agents: 7, tokens: 400_000 } } }], 210_000, { model: 'anthropic/claude-opus-5-5' }),
    m('user', [{ type: 'tool_result', toolUseId: 'tu_fo_wf', content: 'Workflow review-changes started. Run wfr_fanout.', meta: { workflowRunId: 'wfr_fanout', background: true } }], 211_000),
    notice({ ...KIDS[1] }, 300_000),
    reminder([block(KIDS[1], 'Patch: cap the body at 10 MB with `c.req.raw.headers.get("content-length")` before `JSON.parse`, in `routes/import.ts:48`.')], 300_500),
    m('assistant', [{ type: 'tool_use', id: 'tu_fo_wfs', name: 'WorkflowStatus', input: { runId: 'wfr_fanout' } }], 305_000),
    m('user', [{ type: 'tool_result', toolUseId: 'tu_fo_wfs', content: 'Run wfr_fanout, phase 2 of 3.', meta: { workflowRunId: 'wfr_fanout' } }], 306_000),
    m('assistant', [{ type: 'text', text: 'The review is in its second phase. I will report when it ends.' }], 307_000, { model: 'anthropic/claude-opus-5-5' }),
  ];

  const base = { agent: 'explore', mode: 'agent', permissionMode: 'default', cwd: '~/code/conclave', device: 'local', tags: [], pinned: false, archived: false, stats: { messages: 4, inputTokens: 40_000, outputTokens: 2_000, cacheReadTokens: 0, costUsd: 0.1 } };
  const session = { ...base, id: S, title: 'Audit for unsafe deserialization', agent: 'coder', model: 'anthropic/claude-opus-5-5', status: 'idle', createdAt: t0, updatedAt: t0 + 307_000 } as Session;
  const children = KIDS.map((k) => ({ ...base, id: k.id, parentId: S, title: k.label, agent: k.agent, model: k.model, status: k.state === 'limited' ? 'waiting_reset' : 'idle', createdAt: t0 + 6_000, updatedAt: t0 + 6_000 + k.took, meta: { background: { parentId: S, state: k.state === 'completed' ? 'completed' : k.state } } }) as unknown as Session);

  const wt = t0 + 211_000;
  const agent = (seq: number, label: string, phase: string, state: WorkflowCall['state']): WorkflowCall => ({ seq, kind: 'agent', label, phase, state, attempt: 1, inputTokens: 20_000, outputTokens: 1_500, costUsd: 0.08, queuedAt: wt, ...(state !== 'queued' ? { startedAt: wt + seq * 1000 } : {}), ...(state === 'done' ? { finishedAt: wt + 40_000 + seq * 5000 } : {}) }) as WorkflowCall;
  const calls = [agent(1, 'map the import path', 'Map', 'done'), agent(2, 'finder 1', 'Find', 'done'), agent(3, 'finder 2', 'Find', 'running'), agent(4, 'finder 3', 'Find', 'running'), agent(5, 'finder 4', 'Find', 'queued')];
  const run: WorkflowRun = {
    id: 'wfr_fanout',
    name: 'review-changes',
    source: 'builtin',
    status: 'running',
    sessionId: S,
    toolUseId: 'tu_fo_wf',
    device: 'local',
    cwd: '~/code/conclave',
    phases: [{ title: 'Map' }, { title: 'Find' }, { title: 'Verify' }],
    phaseIndex: 1,
    phaseTitle: 'Find',
    inputTokens: 100_000,
    outputTokens: 7_500,
    costUsd: 0.4,
    counts: { agents: 7, queued: 3, running: 2, done: 2, cached: 0, failed: 0, skipped: 0, parked: 0 },
    portable: true,
    createdAt: wt,
    startedAt: wt,
  } as WorkflowRun;
  return { session, children, messages, run, calls };
}
