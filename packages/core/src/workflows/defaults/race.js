export const meta = {
  name: 'race',
  description: 'Race several agents on one task, each in its own worktree from the same commit, run the check in each, and have a blind judge panel pick the best passing change for you to keep',
  whenToUse: 'When a task has more than one plausible solution and you want to keep the best. Nothing is merged until you press Keep winner in the run view. args: { task: string, check: string, n?: 3, arms?: [{ name, model, agentType? }] }',
  runtime: 'conclave',
  phases: [{ title: 'Run' }, { title: 'Check' }, { title: 'Judge' }, { title: 'Report' }],
}

const A = args && typeof args === 'object' ? args : {}
const task = String(A.task || '').trim()
const check = String(A.check || '').trim()
if (!task || !check) throw new Error('race needs args.task and args.check')
const n = Math.max(2, Math.min(6, Math.floor(Number(A.n) || 3)))
const arms = Array.isArray(A.arms) && A.arms.length ? A.arms : Array.from({ length: n }, (_, i) => ({ name: 'racer ' + (i + 1), agentType: 'coder' }))

phase('Run')
const runs = await pipeline(arms, (arm) =>
  agent(
    ['Do this task in the repository. Run the check before you say it is done.', lib.fence('task', task), 'Check: ' + check].join('\n\n'),
    { label: arm.name, phase: 'Run', isolation: 'worktree', ...(arm.model ? { model: arm.model } : {}), ...(arm.agentType ? { agentType: arm.agentType } : {}), conclave: { withMeta: true } },
  ),
)

phase('Check')
const results = []
for (let i = 0; i < arms.length; i++) {
  const r = runs[i]
  if (!r || !r.worktree || !r.worktree.commit) {
    results.push({ arm: arms[i].name, ran: false, passed: false })
    continue
  }
  const c = await lib.runCheck(check, { worktree: r.seq })
  results.push({ arm: arms[i].name, ran: true, seq: r.seq, model: r.model, passed: !!c.ok, files: r.worktree.files, costUsd: r.costUsd, seconds: Math.round(r.durationMs / 1000) })
}
const passing = results.filter((r) => r.passed)
const race = { winner: null, reasons: [], arms: results }
if (!passing.length) {
  phase('Report')
  return { task, race, report: 'No racer passed `' + check + '`, so there is no winner to keep. Each change is on its own kept branch below.' }
}

phase('Judge')
let pick = 0
if (passing.length > 1) {
  const diffs = []
  for (const r of passing) diffs.push(await lib.diff(r.seq))
  const p = await lib.judgePanel(diffs, { judges: 3, rubric: 'Correctness first: the diff does the task. Then the smallest change, then readability. Penalise weakened, skipped or special-cased tests.\n\nTask: ' + task, phase: 'Judge', label: 'judge' })
  // no clear vote: the highest mean score, so the owner still gets one to look at
  pick = p.winner !== null ? p.winner : p.scores.indexOf(Math.max(...p.scores))
  race.reasons = [...new Set((p.reasons[pick] || []).filter(Boolean))].slice(0, 4)
  race.votes = p.votes
  for (let i = 0; i < passing.length; i++) passing[i].score = Math.round(p.scores[i] * 10) / 10
} else {
  race.reasons = ['The only racer whose check passed.']
}
race.winner = passing[pick].seq

phase('Report')
const lines = results.map((r) => '- ' + r.arm + ': ' + (!r.ran ? 'made no change' : r.passed ? 'check passed' + (r.score !== undefined ? ', score ' + r.score : '') : 'check failed'))
return {
  task,
  race,
  report: ['**' + passing[pick].arm + '** wins.', ...race.reasons.map((x) => '> ' + x), '', ...lines, '', 'Nothing is merged yet. Keep winner applies its branch; the other branches are deleted only after that.'].join('\n'),
}
