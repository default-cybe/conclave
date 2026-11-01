export const meta = {
  name: 'fix-until-green',
  description: 'Run a check; on failure a debugger finds the root cause and a builder fixes it; repeat until it passes or two rounds make no progress',
  whenToUse: 'When a test suite, typecheck or build is red and you want it green. args: { check: string, maxRounds?: 5, isolate?: true to work in a worktree instead of the session folder }',
  runtime: 'conclave',
  phases: [{ title: 'Check' }, { title: 'Diagnose' }, { title: 'Fix' }],
}

const A = typeof args === 'string' ? { check: args } : args && typeof args === 'object' ? args : {}
const check = String(A.check || '').trim()
if (!check) throw new Error('fix-until-green needs args.check')
const maxRounds = Number.isInteger(A.maxRounds) && A.maxRounds > 0 ? Math.min(A.maxRounds, 10) : 5
const isolate = A.isolate === true

const failingCount = (tail) => {
  const m = /(\d+)\s+(?:failed|failing|fail|errors?)\b/i.exec(tail)
  return m ? Number(m[1]) : 1
}
let last
let previous = Infinity
let stalls = 0
const rounds = []
for (let round = 1; round <= maxRounds + 1; round++) {
  phase('Check')
  const ran = await lib.runCheck(check, last !== undefined ? { worktree: last } : undefined)
  if (ran.ok) {
    return { green: true, rounds: rounds.length, history: rounds, ...(last !== undefined ? { branchCall: last, note: 'The fix is on the kept branch of call ' + last + '.' } : {}) }
  }
  const failing = failingCount(ran.tail)
  rounds.push({ round, failing, tail: ran.tail.split('\n').slice(-8).join('\n') })
  if (round > maxRounds) break
  if (failing >= previous) stalls++
  else stalls = 0
  previous = failing
  if (stalls >= 2) {
    log('Two rounds without fewer failures; stopping')
    break
  }
  phase('Diagnose')
  const diag = await agent(
    [
      'Find the root cause of this failing check. Run the failing command, read the code, use git log and blame if useful. Diagnose only; do not fix.',
      'Name the root cause as file:line with the chain from input to symptom, the strongest alternative and what rules it out, and the fix in one paragraph.',
      lib.fence('check', check),
      lib.fence('output', ran.tail),
    ].join('\n\n'),
    { label: 'diagnose ' + round, phase: 'Diagnose', agentType: 'debugger', model: 'deep', ...(last !== undefined ? { conclave: { cwd: await lib.checkout(last) } } : {}) },
  )
  phase('Fix')
  const fix = await agent(
    [
      'Fix the root cause below with the smallest change, then run the check. Never weaken or skip a test to make it pass; if a test is wrong, say so and leave it.',
      lib.fence('diagnosis', diag || '(no diagnosis came back; read the output yourself)'),
      lib.fence('check', check),
      lib.fence('output', ran.tail),
    ].join('\n\n'),
    {
      label: 'fix ' + round,
      phase: 'Fix',
      agentType: 'builder',
      ...(isolate ? { isolation: 'worktree', conclave: { withMeta: true, ...(last !== undefined ? { worktreeFrom: last } : {}) } } : {}),
    },
  )
  if (isolate && fix && fix.worktree && fix.worktree.commit) last = fix.seq
}
return { green: false, rounds: rounds.length, history: rounds, ...(last !== undefined ? { branchCall: last } : {}) }
