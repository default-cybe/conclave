export const meta = {
  name: 'ui-pass',
  description: 'A designer builds a UI change inside the design system and takes screenshots; a fresh visual verifier that sees only the screenshots, the brief and the spec decides; one fix round; typecheck and builds run',
  whenToUse: 'For a visual change in the web app. args: { brief: string, spec?: "docs/design/SPEC.md", checks?: ["bun run typecheck", ...] }',
  runtime: 'conclave',
  phases: [{ title: 'Build' }, { title: 'Look' }, { title: 'Fix' }, { title: 'Check' }],
}

const A = typeof args === 'string' ? { brief: args } : args && typeof args === 'object' ? args : {}
const brief = String(A.brief || '').trim()
if (!brief) throw new Error('ui-pass needs args.brief')
const spec = A.spec || 'docs/design/SPEC.md'
const checks = Array.isArray(A.checks) && A.checks.length ? A.checks : ['cd packages/web && bunx tsc --noEmit -p .', 'cd packages/web && bun run build', 'cd packages/web && bun run build:mock']

const shotSchema = {
  type: 'object',
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    screenshots: { type: 'array', items: { type: 'string', description: 'Absolute paths of the PNGs' } },
    rules: { type: 'array', items: { type: 'object', properties: { rule: { type: 'string' }, pass: { type: 'boolean' } }, required: ['rule', 'pass'] } },
    notChecked: { type: 'array', items: { type: 'string' } },
  },
  required: ['files', 'screenshots'],
}
const build = (extra, from) =>
  agent(
    [
      'Make this UI change inside the project\'s design system: compose existing components and tokens, add no tokens or fonts, and name the ' + spec + ' rule before you break one. Then take 4 screenshots from the mock server: 390 and 1440 wide, light and dark, and look at them before you report.',
      lib.fence('brief', brief),
      extra || '',
    ].filter(Boolean).join('\n\n'),
    { label: from === undefined ? 'design' : 'design fix', phase: from === undefined ? 'Build' : 'Fix', agentType: 'designer', schema: shotSchema, isolation: 'worktree', conclave: { withMeta: true, ...(from !== undefined ? { worktreeFrom: from } : {}) } },
  )
const look = (shots) =>
  agent(
    [
      'Judge whether a UI change meets its brief from screenshots only. Start from "not achieved until proven": pass a point only when a screenshot shows it. Check the spec rules in section 2 of ' + spec + ': no emoji, no gradients, calm type, no horizontal scroll at 390 wide.',
      lib.fence('brief', brief),
      'Screenshots (open each with Read): ' + shots.join(', '),
    ].join('\n\n'),
    {
      label: 'visual verify',
      phase: 'Look',
      agentType: 'verifier',
      schema: { type: 'object', properties: { achieved: { type: 'boolean' }, problems: { type: 'array', items: { type: 'string' } } }, required: ['achieved', 'problems'] },
    },
  )

phase('Build')
let made = await build()
if (!made || !made.value) return { passed: false, stopped: 'the designer returned nothing' }
phase('Look')
let verdict = await look(made.value.screenshots || [])
if (verdict && !verdict.achieved && made.worktree && made.worktree.commit) {
  phase('Fix')
  const fixed = await build(lib.fence('verifier-problems', verdict.problems.join('\n')), made.seq)
  if (fixed && fixed.value) {
    made = fixed
    phase('Look')
    verdict = await look(made.value.screenshots || [])
  }
}
phase('Check')
const results = []
for (const c of checks) {
  const r = made.worktree && made.worktree.commit ? await lib.runCheck(c, { worktree: made.seq }) : await lib.runCheck(c)
  results.push({ command: c, ok: r.ok, tail: r.ok ? '' : r.tail.split('\n').slice(-8).join('\n') })
}
return {
  passed: !!(verdict && verdict.achieved && results.every((r) => r.ok)),
  screenshots: made.value.screenshots,
  rules: made.value.rules || [],
  problems: verdict ? verdict.problems : ['no visual verdict'],
  checks: results,
  notChecked: made.value.notChecked || [],
  ...(made.worktree && made.worktree.commit ? { branchCall: made.seq } : {}),
}
