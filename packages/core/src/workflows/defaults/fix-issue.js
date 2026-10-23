export const meta = {
  name: 'fix-issue',
  description: 'Fix a reported bug: localize it, write a reproduction test that must fail first, three fixes from different angles in separate worktrees, keep the ones that pass, and let a judge panel pick the smallest correct one',
  whenToUse: 'For a bug report with a clear symptom. args: { issue: string, check: the regression suite command }',
  runtime: 'conclave',
  phases: [{ title: 'Localize' }, { title: 'Reproduce' }, { title: 'Fix' }, { title: 'Test' }, { title: 'Judge' }],
}

const A = args && typeof args === 'object' ? args : {}
const issue = String(A.issue || '').trim()
const check = String(A.check || '').trim()
if (!issue || !check) throw new Error('fix-issue needs args.issue and args.check')

phase('Localize')
const where = (await parallel(
  ['the code path from the symptom back to its cause', 'recent changes in that area (git log, blame)', 'the tests that should have caught it'].map((a, i) => () =>
    agent(['Localize a bug. Answer with file:line anchors. Thoroughness: medium.', 'Your angle: ' + a, lib.fence('issue', issue)].join('\n\n'), { label: 'localize ' + (i + 1), phase: 'Localize', agentType: 'explore' }),
  ),
)).filter(Boolean).join('\n\n---\n\n')

phase('Reproduce')
const repro = await agent(
  [
    'Write one test that reproduces this bug and fails on the current code, using the project\'s test runner and layout. Do not fix the code. Return the test file and the command that runs only it.',
    lib.fence('issue', issue),
    lib.fence('where', where.slice(0, 30000)),
  ].join('\n\n'),
  {
    label: 'repro test',
    phase: 'Reproduce',
    agentType: 'tester',
    isolation: 'worktree',
    schema: { type: 'object', properties: { testFile: { type: 'string' }, command: { type: 'string' } }, required: ['testFile', 'command'] },
    conclave: { withMeta: true },
  },
)
if (!repro || !repro.value || !repro.worktree || !repro.worktree.commit) return { fixed: false, stopped: 'no reproduction test was written' }
const before = await lib.runCheck(repro.value.command, { worktree: repro.seq })
// the reproduction must fail because of the bug: a test that cannot run, or that is not on the branch, shows nothing
const shown = lib.failingTest(before, { diff: await lib.diff(repro.seq), testFile: repro.value.testFile })
if (!shown.proven) return { fixed: false, stopped: 'the reproduction test does not show the bug: ' + shown.why, test: repro.value.testFile, tail: before.tail }
const testFile = String(repro.value.testFile).replace(/^\.\//, '')

phase('Fix')
const ANGLES = ['the smallest change that makes the test pass without special-casing it', 'the root cause, even when that is a larger change', 'a guard at the boundary where the bad input enters']
const fixes = await pipeline(ANGLES, (angle, _, i) =>
  agent(
    [
      'Fix this bug. The reproduction test is already in your worktree; make it pass without editing it or special-casing it, and keep the regression suite green.',
      'Your angle: ' + angle,
      lib.fence('issue', issue),
      lib.fence('where', where.slice(0, 20000)),
      'Reproduction: ' + repro.value.command + ' (' + repro.value.testFile + ')',
    ].join('\n\n'),
    { label: 'fix ' + (i + 1), phase: 'Fix', agentType: 'builder', isolation: 'worktree', conclave: { withMeta: true, worktreeFrom: repro.seq } },
  ),
)

phase('Test')
const tested = await pipeline(fixes, async (f, _, i) => {
  const angle = ANGLES[i]
  if (!f || !f.worktree || !f.worktree.commit) return null
  // a fix that edits or deletes the reproduction test passes it for the wrong reason
  const touched = lib.diffFiles(await lib.diff(f.seq))
  if (touched.some((p) => p === testFile || testFile.endsWith('/' + p) || p.endsWith('/' + testFile))) {
    log('fix ' + (i + 1) + ' (' + angle + ') edited the reproduction test; it is not counted')
    return { seq: f.seq, angle, branch: f.worktree.branch, files: f.worktree.files, ok: false, tampered: true, tail: 'edited the reproduction test' }
  }
  const r1 = await lib.runCheck(repro.value.command, { worktree: f.seq })
  const r2 = r1.ok ? await lib.runCheck(check, { worktree: f.seq }) : null
  return { seq: f.seq, angle, branch: f.worktree.branch, files: f.worktree.files, ok: r1.ok && !!r2 && r2.ok, tail: (r2 || r1).tail.split('\n').slice(-6).join('\n') }
})
const passing = tested.filter((x) => x && x.ok)
log(passing.length + ' of ' + ANGLES.length + ' fixes pass the reproduction and the suite')
if (!passing.length) return { fixed: false, tried: tested.filter(Boolean), test: repro.value.testFile }
if (passing.length === 1) return { fixed: true, winner: passing[0], test: repro.value.testFile, note: 'Offer the owner Merge on the kept branch of call ' + passing[0].seq + '.' }

phase('Judge')
const diffs = []
for (const p of passing) diffs.push(await lib.diff(p.seq))
const panel = await lib.judgePanel(diffs, { judges: 3, rubric: 'A correct fix for the issue first; then the smallest diff; then readability. A diff that edits the reproduction test or special-cases it scores 0.\n\nIssue: ' + issue, phase: 'Judge' })
const winner = panel.winner === null ? passing.slice().sort((a, b) => a.files - b.files)[0] : passing[panel.winner]
if (panel.winner === null) log('The judges did not agree; picked the fix that touches the fewest files')
return { fixed: true, winner, candidates: passing, votes: panel.votes, test: repro.value.testFile, note: 'Offer the owner Merge on the kept branch of call ' + winner.seq + '.' }
