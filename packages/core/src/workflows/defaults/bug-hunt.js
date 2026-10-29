export const meta = {
  name: 'bug-hunt',
  description: 'Hunt for bugs until two rounds find nothing new: finders by angle each round, citations checked, a refuter panel per finding, failing tests for the top survivors',
  whenToUse: 'To look for bugs in a codebase or a part of it, not a single change. args: { path?: a folder to stay in, maxRounds?: 4, prove?: 3, round?: the ledger round, default one past the highest }',
  runtime: 'conclave',
  phases: [{ title: 'Angles' }, { title: 'Find' }, { title: 'Verify' }, { title: 'Prove' }, { title: 'Report' }],
}

const A = args && typeof args === 'object' ? args : {}
const scope = typeof A.path === 'string' && A.path ? A.path : '.'
if (scope.startsWith('-')) throw new Error('args.path must be a folder, not an option')
const maxRounds = Number.isInteger(A.maxRounds) ? A.maxRounds : 4
const proveTop = Number.isInteger(A.prove) ? A.prove : 3

phase('Angles')
// plain git output (read-only, so it never asks); counted and ranked here instead of with awk and sort
const mostCommon = (list, n) => {
  const counts = {}
  for (const x of list) counts[x] = (counts[x] || 0) + 1
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k)
}
const files = (await lib.exec('git ls-files -- ' + lib.shq(scope))).stdout.split('\n').filter(Boolean)
const packages = mostCommon(files.map((f) => { const p = f.split('/'); return p.length > 2 ? p[0] + '/' + p[1] : p[0] }), 6)
const churn = mostCommon((await lib.exec('git log --since=30.days --name-only --pretty=format: -- ' + lib.shq(scope))).stdout.split('\n').map((l) => l.trim()).filter(Boolean), 12)
const ANGLES = [
  ...packages.map((p) => ({ id: 'pkg ' + p, text: 'the package ' + p + ': its main paths end to end' })),
  { id: 'churn', text: 'files changed most in the last 30 days: ' + (churn.join(', ') || 'none found') },
  { id: 'errors', text: 'error handling paths: catch blocks, retries, cleanup, timeouts, partial failures' },
  { id: 'todo', text: 'TODO, FIXME and skipped or disabled tests, and what they hide' },
  { id: 'input', text: 'public input boundaries: routes, CLI flags, file and network parsers, config loading' },
]
log(ANGLES.length + ' angles: ' + ANGLES.map((a) => a.id).join(', '))

const key = (f) => f.file + ':' + Math.round((f.line || 0) / 5) + ':' + String(f.class || f.title || '').toLowerCase().split(/\s+/).slice(0, 3).join(' ')

// the project's findings ledger: finders read it, fixed and rejected items are not reported again, results are written back last
const ledger = await lib.ledger.read('.')
const ledgerRound = Number.isInteger(A.round) ? A.round : ledger.reduce((m, e) => Math.max(m, e.round), 0) + 1
const ledgerText = lib.ledger.fence(ledger)
const closed = new Map(ledger.filter((e) => e.verdict !== 'open').map((e) => [e.id, e.verdict]))
const ledgerId = (f) => lib.ledger.id(f.file + ': ' + f.title)
const isClosed = (f) => { const v = closed.get(ledgerId(f)); return v === 'rejected' || v === 'wontfix' || (v === 'fixed' && f.regressed !== true) }
if (ledger.length) log('ledger: ' + ledger.length + ' entries, ' + closed.size + ' closed; this is round ' + ledgerRound)
const finding = lib.schemas.finding
const findingsSchema = { ...lib.schemas.findings, properties: { ...lib.schemas.findings.properties, findings: { type: 'array', items: { ...finding, properties: { ...finding.properties, regressed: { type: 'boolean', description: 'A ledger item marked fixed that your evidence shows came back' } } } } } }
const read = new Set()
const notReached = new Set()
phase('Find')
const confirmed = await lib.loopUntilDry(
  async (round, already) => {
    phase('Find')
    const results = (await pipeline(ANGLES, (a) =>
      agent(
        [
          'Find real bugs in this code from one angle. Report every candidate with the file and line, the cited line copied exactly as quote, a concrete triggering input as scenario, and a priority P0 to P3. Read what you cite; never install dependencies.',
          'Your angle: ' + a.text,
          'Stay inside: ' + scope,
          ledgerText,
          already.length ? lib.fence('already-found', already.map((f) => f.file + ':' + f.line + ' ' + f.title).join('\n')) + '\nDo not report these again.' : '',
        ].filter(Boolean).join('\n\n'),
        { label: 'r' + round + ' ' + a.id, phase: 'Find', agentType: 'reviewer', schema: findingsSchema },
      ),
    )).filter(Boolean)
    for (const r of results) {
      for (const f of r.read || []) read.add(f)
      for (const f of r.notReached || []) notReached.add(f)
    }
    const cited = await lib.checkCitations(lib.dedupe(results.flatMap((r) => r.findings || [])))
    const open = cited.kept.filter((f) => !isClosed(f))
    if (open.length < cited.kept.length) log('ledger: dropped ' + (cited.kept.length - open.length) + ' findings marked fixed, rejected or wontfix')
    const fresh = await lib.dropDismissed(open)
    phase('Verify')
    // only a complete panel that refutes a finding marks it rejected in the ledger
    const judged = await pipeline(fresh, (f) => lib.panel(f, { phase: 'Verify', agentType: 'verifier', effort: 'xhigh', model: 'deep' }).then((p) => (p.kept ? { ...f, priority: p.severity || f.priority, confidence: p.confidence } : p.complete ? { ...f, refuted: true, rejected: true } : null)))
    // everything seen counts toward "nothing new", confirmed or not, so the loop converges
    return fresh.map((f) => judged.find((j) => j && j.file === f.file && j.line === f.line) || { ...f, refuted: true })
  },
  { k: 2, key, maxRounds },
)
const real = confirmed.filter((f) => !f.refuted)

phase('Prove')
const top = real.filter((f) => f.priority === 'P0' || f.priority === 'P1').slice(0, proveTop)
const proofs = await pipeline(top, async (f) => {
  const r = await agent(
    ['Write one test that fails on the current code because of this bug. Do not fix the code. Return the test file and the command that runs only it.', lib.fence('bug', { file: f.file, line: f.line, quote: f.quote, title: f.title, scenario: f.scenario })].join('\n\n'),
    { label: 'prove ' + f.file + ':' + f.line, phase: 'Prove', agentType: 'tester', isolation: 'worktree', schema: { type: 'object', properties: { testFile: { type: 'string' }, command: { type: 'string' } }, required: ['testFile', 'command'] }, conclave: { withMeta: true } },
  )
  if (!r || !r.value || !r.worktree || !r.worktree.commit) return null
  const c = await lib.runCheck(r.value.command, { worktree: r.seq })
  // a test that cannot run, or one that is not on the branch, proves nothing
  const proof = lib.failingTest(c, { diff: await lib.diff(r.seq), testFile: r.value.testFile })
  if (!proof.proven) log('Not proven: ' + f.file + ':' + f.line + ': ' + proof.why)
  return { key: key(f), proven: proof.proven, why: proof.why, test: r.value.testFile, branch: r.worktree.branch }
})

phase('Report')
const findings = real.map((f) => {
  const p = proofs.find((x) => x && x.key === key(f))
  return { ...f, proven: !!(p && p.proven), ...(p ? { test: p.test, testBranch: p.branch } : {}) }
})
const LEDGER_SEVERITY = { P0: 'high', P1: 'high', P2: 'medium', P3: 'low' }
await lib.ledger.write('.', confirmed.filter((f) => !f.refuted || f.rejected).map((f) => ({
  id: ledgerId(f),
  finding: f.file + ': ' + f.title,
  severity: LEDGER_SEVERITY[f.priority] || 'medium',
  verdict: f.refuted ? 'rejected' : 'open',
  round: ledgerRound,
  evidence: f.file + ':' + f.line,
})))
const unread = [...notReached].filter((f) => !read.has(f))
if (unread.length) log('Not covered: ' + unread.slice(0, 20).join(', '))
return {
  findings,
  refuted: confirmed.length - real.length,
  coverage: { read: [...read], notReached: unread },
  report: findings.length
    ? findings.map((f) => '- ' + f.priority + (f.proven ? ' proven' : '') + ' ' + f.file + ':' + f.line + ' ' + f.title).join('\n')
    : 'No bugs survived the refuter panel. ' + read.size + ' files read.',
}
