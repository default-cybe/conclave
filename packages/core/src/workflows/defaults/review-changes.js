export const meta = {
  name: 'review-changes',
  description: 'Review a change: five finder lenses each run twice, citations checked in code, a three-vote refuter panel per finding, and failing tests for the worst ones',
  whenToUse: 'Before you merge or commit a change. args: { base?: a branch or commit to diff against (default: uncommitted changes against HEAD), focus?: what to look at hardest, votes?: 3, maxVerify?: 20, worktreeFrom?: a call seq whose kept commit to review (from another workflow) }',
  runtime: 'conclave',
  phases: [
    { title: 'Scope', detail: 'the diff, staged, unstaged and untracked changes, changed files' },
    { title: 'Find', detail: 'five lenses, each run twice with the file order reversed' },
    { title: 'Check', detail: 'citations within 3 lines, duplicates merged, dismissed findings dropped' },
    { title: 'Verify', detail: 'three refuters per finding, kept at 2 of 3 complete votes' },
    { title: 'Prove', detail: 'a failing test in a worktree for each P0 and P1' },
    { title: 'Report' },
  ],
}

const A = args && typeof args === 'object' ? args : {}
const MAX_VERIFY = Number.isInteger(A.maxVerify) ? A.maxVerify : 20
const DIFF_CHARS = 60000

// ---------- Scope ----------
phase('Scope')
let diff = ''
let files = []
let scopeLine = ''
let viewCwd
if (Number.isInteger(A.worktreeFrom)) {
  diff = await lib.diff(A.worktreeFrom)
  viewCwd = await lib.checkout(A.worktreeFrom)
  files = [...new Set((diff.match(/^\+\+\+ b\/(.+)$/gm) || []).map((l) => l.slice(6)))]
  scopeLine = 'the branch of call ' + A.worktreeFrom
} else if (A.base) {
  // a ref name only: it goes into a shell command, and a leading dash would read as an option
  const ref = String(A.base)
  if (!/^[A-Za-z0-9._\/@{}^~+-]+$/.test(ref) || ref.startsWith('-')) throw new Error('args.base must be a branch, tag or commit, not ' + JSON.stringify(ref.slice(0, 80)))
  const mb = await lib.exec('git merge-base HEAD ' + lib.shq(ref))
  if (mb.exitCode !== 0) throw new Error('args.base ' + JSON.stringify(ref) + ' is not a commit in this repository: ' + (mb.stderr || mb.stdout).trim().slice(0, 200))
  const base = mb.stdout.trim()
  diff = (await lib.exec('git diff ' + lib.shq(base))).stdout
  files = (await lib.exec('git diff --name-only ' + lib.shq(base))).stdout.split('\n').filter(Boolean)
  scopeLine = 'changes since ' + ref
} else {
  const staged = (await lib.exec('git diff --cached')).stdout
  const unstaged = (await lib.exec('git diff')).stdout
  const untracked = (await lib.exec('git ls-files --others --exclude-standard')).stdout.split('\n').filter(Boolean)
  diff = [staged, unstaged].filter(Boolean).join('\n')
  files = [...new Set([...(await lib.exec('git diff HEAD --name-only')).stdout.split('\n').filter(Boolean), ...untracked])]
  if (untracked.length) diff += '\n# Untracked files (new, not in the diff): ' + untracked.join(', ')
  scopeLine = 'uncommitted changes against HEAD'
}
if (!files.length && !diff.trim()) {
  return { verdict: 'safe to merge', report: 'Nothing to review: there are no ' + scopeLine + '.', findings: [], coverage: { read: [], notReached: [] } }
}
log('Reviewing ' + scopeLine + ': ' + files.length + ' files, ' + diff.length + ' chars of diff')
let diffForPrompt = diff
if (diff.length > DIFF_CHARS) {
  diffForPrompt = diff.slice(0, DIFF_CHARS)
  log('The diff is ' + diff.length + ' chars; finders get the first ' + DIFF_CHARS + ' and read the rest from the files')
}

// ---------- Find ----------
phase('Find')
const RUBRIC = [
  'Report every problem this change introduces that the author would want to fix: discrete and actionable, with the affected code shown, not guessed.',
  'Do not report style, naming or issues that a linter or the type checker catches. Do not report problems in code the change did not touch, unless the change makes them reachable.',
  'Report all candidates; a separate pass filters them. For each: the file and line, the cited line copied exactly as quote, a concrete triggering input or sequence as scenario, what happens and what should happen, and a priority from P0 (breaks users or data) to P3 (minor).',
  'Read the code you cite. Do not run tests or scripts from the change until you have read what they add. Never install dependencies.',
  'If there is nothing a person would definitely want to see and fix, return no findings.',
].join('\n')
const LENSES = [
  { id: 'correctness', text: 'Correctness: wrong results, broken edge cases (empty, null, zero, one, many, unicode, large), off-by-one, wrong conditions.', model: 'deep' },
  { id: 'contracts', text: 'Callers and contracts not updated: changed signatures, return shapes, config keys, events or routes whose other side still expects the old form. Search for the callers.' },
  { id: 'security', text: 'Security: name the source (who controls the input) and the sink (where it does harm): injection, path traversal, authz gaps, secrets in logs, unsafe deserialization.' },
  { id: 'tests', text: 'Tests removed, skipped or weakened, assertions loosened, or behavior changed with no test that pins it.' },
  { id: 'errors', text: 'Error and concurrency paths: swallowed errors, missing awaits, races, leaks, retries without limits, cleanup that does not run.' },
]
const passes = []
for (const lens of LENSES) for (const order of ['forward', 'reversed']) passes.push({ lens, order })
const found = await pipeline(passes, (p) => {
  const list = p.order === 'forward' ? files : files.slice().reverse()
  const prompt = [
    'You are reviewing a change in finder mode. ' + RUBRIC,
    'Your lens: ' + p.lens.text,
    A.focus ? 'The owner asked to look hardest at: ' + A.focus : '',
    'Files changed, in the order to read them: ' + list.join(', '),
    lib.fence('diff', diffForPrompt),
    'Return findings through StructuredOutput, plus the files you read and the ones you did not reach.',
  ].filter(Boolean).join('\n\n')
  return agent(prompt, {
    label: 'find ' + p.lens.id + ' ' + p.order,
    phase: 'Find',
    agentType: 'reviewer',
    schema: lib.schemas.findings,
    model: p.lens.model,
    ...(viewCwd ? { conclave: { cwd: viewCwd } } : {}),
  }).then((r) => (r ? { lens: p.lens.id, order: p.order, ...r } : null))
})
const passResults = found.filter(Boolean)
if (passResults.length < passes.length) log((passes.length - passResults.length) + ' of ' + passes.length + ' finder passes returned nothing usable')
const read = [...new Set(passResults.flatMap((r) => r.read || []))]
const notReached = [...new Set(passResults.flatMap((r) => r.notReached || []))].filter((f) => !read.includes(f))
const raw = passResults.flatMap((r) => (r.findings || []).map((f) => ({ ...f, lens: r.lens, pass: r.lens + ':' + r.order })))
log('Finders reported ' + raw.length + ' candidates')

// ---------- Check ----------
phase('Check')
const merged = lib.dedupe(raw, { window: 5 })
// a P2 or P3 seen by one pass only is dropped; two passes or a P0/P1 stay
const twice = merged.filter((f) => f.priority === 'P0' || f.priority === 'P1' || (f.seenBy || 1) >= 2)
const droppedSingle = merged.length - twice.length
if (droppedSingle) log('Dropped ' + droppedSingle + ' P2/P3 candidates that only one pass saw')
const cited = await lib.checkCitations(twice, Number.isInteger(A.worktreeFrom) ? { worktree: A.worktreeFrom } : undefined)
const fresh = await lib.dropDismissed(cited.kept)
const byPriority = fresh.slice().sort((a, b) => String(a.priority).localeCompare(String(b.priority)))
const toVerify = byPriority.slice(0, MAX_VERIFY)
if (byPriority.length > MAX_VERIFY) log('Verifying the top ' + MAX_VERIFY + ' by priority; ' + (byPriority.length - MAX_VERIFY) + ' lower ones were not verified: ' + byPriority.slice(MAX_VERIFY).map((f) => f.file + ':' + f.line).join(', '))

// ---------- Verify ----------
phase('Verify')
const panels = await pipeline(toVerify, (f) =>
  lib.panel(f, {
    phase: 'Verify',
    agentType: 'verifier',
    effort: 'xhigh',
    model: 'deep',
    context: 'The change under review:\n' + diffForPrompt.slice(0, 20000),
  }).then((p) => ({ f, p })),
)
const verified = panels.filter(Boolean)
const confirmed = verified.filter((x) => x.p.kept).map((x) => ({ ...x.f, priority: x.p.severity || x.f.priority, confidence: x.p.confidence, votes: x.p.votes.map((v) => v && v.verdict) }))
const unverifiable = verified.filter((x) => !x.p.kept && x.p.votes.some((v) => v && v.verdict === 'unverifiable')).map((x) => x.f)
const refuted = verified.length - confirmed.length - unverifiable.length

// ---------- Prove ----------
phase('Prove')
const serious = confirmed.filter((f) => f.priority === 'P0' || f.priority === 'P1').slice(0, 5)
const proofSchema = {
  type: 'object',
  properties: { testFile: { type: 'string' }, command: { type: 'string', description: 'The command that runs only the new test' }, note: { type: 'string' } },
  required: ['testFile', 'command'],
}
const proofs = await pipeline(serious, async (f) => {
  const r = await agent(
    [
      'Write one test that fails on the current code because of this finding, using the project\'s own test runner and layout. Do not fix the code.',
      lib.fence('finding', { file: f.file, line: f.line, quote: f.quote, title: f.title, scenario: f.scenario }),
      'Commit nothing; leave the test file in place. Return the test file and the command that runs only that test.',
    ].join('\n\n'),
    { label: 'prove ' + f.file + ':' + f.line, phase: 'Prove', agentType: 'tester', schema: proofSchema, isolation: 'worktree', conclave: { withMeta: true, ...(Number.isInteger(A.worktreeFrom) ? { worktreeFrom: A.worktreeFrom } : {}) } },
  )
  if (!r || !r.value || !r.worktree || !r.worktree.commit) return { f, proven: false, why: 'no test was written' }
  const check = await lib.runCheck(r.value.command, { worktree: r.seq })
  // a test that cannot run, or one that is not on the branch, proves nothing
  const proof = lib.failingTest(check, { diff: await lib.diff(r.seq), testFile: r.value.testFile })
  if (!proof.proven) log('Not proven: ' + f.file + ':' + f.line + ': ' + proof.why)
  return { f, proven: proof.proven, why: proof.why, test: r.value.testFile, branch: r.worktree.branch, tail: check.tail.split('\n').slice(-10).join('\n') }
})
const provenKeys = new Set(proofs.filter((p) => p && p.proven).map((p) => p.f.file + ':' + p.f.line))
const findings = confirmed.map((f) => {
  const proof = proofs.find((p) => p && p.f === f)
  return { ...f, proven: provenKeys.has(f.file + ':' + f.line), ...(proof && proof.test ? { test: proof.test, testBranch: proof.branch } : {}) }
})

// ---------- Report ----------
phase('Report')
const proven = findings.filter((f) => f.proven)
const rest = findings.filter((f) => !f.proven)
const blocking = findings.some((f) => f.priority === 'P0' || f.priority === 'P1')
const verdict = !findings.length ? 'safe to merge' : blocking ? 'changes needed' : 'safe to merge after the notes below'
const line = (f) => '- ' + f.priority + ' ' + f.file + ':' + f.line + ' ' + f.title + (f.scenario ? '. Trigger: ' + f.scenario : '')
const dropped = { singlePass: droppedSingle, citation: cited.dropped, dismissed: cited.kept.length - fresh.length, notVerified: Math.max(0, byPriority.length - MAX_VERIFY), refuted }
let report
if (!findings.length && !unverifiable.length) {
  report = 'Safe to merge. ' + raw.length + ' candidates were checked; none survived the citation check and three independent refuters.' + (notReached.length ? ' Not reached: ' + notReached.slice(0, 5).join(', ') + '.' : '')
} else {
  report = [
    'Verdict: ' + verdict + '.',
    proven.length ? '\nProven by a failing test:\n' + proven.map(line).join('\n') : '',
    rest.length ? '\nConfirmed by 2 or 3 of 3 refuters:\n' + rest.map(line).join('\n') : '',
    unverifiable.length ? '\nCould not be checked (not confirmed, not refuted):\n' + unverifiable.map(line).join('\n') : '',
    '\nDropped: ' + Object.entries(dropped).map(([k, v]) => k + ' ' + v).join(', ') + '.',
    notReached.length ? 'Coverage: ' + read.length + ' files read; not reached: ' + notReached.join(', ') + '.' : 'Coverage: ' + read.length + ' files read.',
  ].filter(Boolean).join('\n')
}
return { verdict, report, findings, unverifiable, dropped, coverage: { read, notReached } }
