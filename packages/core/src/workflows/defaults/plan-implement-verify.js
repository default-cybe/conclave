export const meta = {
  name: 'plan-implement-verify',
  description: 'Understand, ask only what would change the work, plan with a check per step, build one step at a time in one worktree, then let the tests and a review decide when it is done',
  whenToUse: 'For a real change: a feature or a fix that touches more than a line or two. args: { task: string, check?: the command that proves it works (tests or typecheck) }. The result offers the branch to merge.',
  runtime: 'conclave',
  phases: [
    { title: 'Understand' },
    { title: 'Clarify', detail: 'at most 3 questions, only when readings differ' },
    { title: 'Plan', detail: 'a check command per step; approval in interactive runs' },
    { title: 'Implement', detail: 'one builder per step, in order, in one worktree' },
    { title: 'Verify', detail: 'the check, then review-changes on the branch' },
    { title: 'Fix', detail: 'at most 3 rounds; a re-plan after 3 stalls' },
  ],
}

const A = typeof args === 'string' ? { task: args } : args && typeof args === 'object' ? args : {}
const task = String(A.task || '').trim()
if (!task) throw new Error('plan-implement-verify needs args.task')

// ---------- Understand ----------
phase('Understand')
const angles = [
  'where this change lands: the files and functions it touches and their callers',
  'how the project already does similar things: the pattern to follow, config, naming',
  'the tests and checks that cover this area, and how to run them',
]
const understanding = (await parallel(angles.map((a, i) => () =>
  agent(['Explore the code for a task. Read what you cite; answer with file:line anchors and end with 5 to 10 files to read next. Thoroughness: medium.', 'Your angle: ' + a, lib.fence('task', task)].join('\n\n'), { label: 'understand ' + (i + 1), phase: 'Understand', agentType: 'explore' }),
))).filter(Boolean)
const context = understanding.join('\n\n---\n\n')

// ---------- Clarify ----------
phase('Clarify')
const amb = await agent(
  [
    'List questions for the owner only where different readings of the task would change the work. At most 3. Each with 2 to 4 short options, the likely default first. If the task is clear, return none.',
    lib.fence('task', task),
    lib.fence('code-context', context.slice(0, 30000)),
  ].join('\n\n'),
  {
    label: 'ambiguity',
    phase: 'Clarify',
    model: 'fast',
    schema: { type: 'object', properties: { questions: { type: 'array', items: { type: 'object', properties: { q: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['q', 'options'] } } }, required: ['questions'] },
  },
)
const answers = []
for (const q of (amb ? amb.questions : []).slice(0, 3)) answers.push({ q: q.q, a: await lib.ask(q.q, q.options) })
const decided = answers.length ? '\n\nThe owner decided:\n' + answers.map((x) => '- ' + x.q + ' ' + x.a).join('\n') : ''

// ---------- Plan ----------
phase('Plan')
const planSchema = {
  type: 'object',
  properties: {
    oneSentence: { type: 'boolean', description: 'true when the whole change fits in one sentence' },
    steps: {
      type: 'array',
      items: { type: 'object', properties: { title: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, detail: { type: 'string' }, check: { type: 'string', description: 'the command that proves this step' } }, required: ['title', 'files', 'check'] },
    },
    check: { type: 'string', description: 'the command that proves the whole change' },
  },
  required: ['oneSentence', 'steps'],
}
const makePlan = (extra) =>
  agent(
    ['Plan this change in steps a builder can do one at a time. Each step names its files and the check command that proves it. If the change fits in one sentence, set oneSentence and give one step.', lib.fence('task', task + decided), lib.fence('code-context', context.slice(0, 40000)), extra || ''].filter(Boolean).join('\n\n'),
    { label: 'plan', phase: 'Plan', agentType: 'planner', schema: planSchema },
  )
let plan = await makePlan()
if (!plan || !plan.steps.length) throw new Error('no plan came back')
const check = A.check || plan.check || plan.steps[plan.steps.length - 1].check
const planText = plan.steps.map((s, i) => i + 1 + '. ' + s.title + ' (' + s.files.join(', ') + '); check: ' + s.check).join('\n')
if (!plan.oneSentence) {
  const ok = await lib.approve('Plan for: ' + task + '\n\n' + planText + '\n\nDone when: ' + check)
  if (!ok) return { done: false, stopped: 'the owner did not approve the plan', plan: planText }
}

// ---------- Implement ----------
const build = async (step, from, extra) => {
  const r = await agent(
    [
      'Implement one step of a plan, and prove it. Touch only the files the step names; if another file must change, stop and say so. If a test contradicts the task, report the conflict and leave the test alone.',
      lib.fence('task', task + decided),
      lib.fence('step', step),
      extra || '',
      'Run the step\'s check before you report. Line 1 of your answer: done, partial or blocked.',
    ].filter(Boolean).join('\n\n'),
    { label: 'build: ' + step.title, phase: 'Implement', agentType: 'builder', isolation: 'worktree', conclave: { withMeta: true, ...(from !== undefined ? { worktreeFrom: from } : {}) } },
  )
  return r
}
phase('Implement')
let last
for (const step of plan.steps) {
  const r = await build(step, last)
  if (!r || !r.worktree) {
    log('step "' + step.title + '" left nothing to build on; stopping')
    break
  }
  if (r.worktree.commit) last = r.seq
  else log('step "' + step.title + '" changed nothing')
}
if (last === undefined) return { done: false, stopped: 'no step changed any file', plan: planText }

// ---------- Verify and fix ----------
let stalls = 0
let replanned = false
let previousFailing = Infinity
let result
for (let round = 0; ; round++) {
  phase('Verify')
  const ran = await lib.runCheck(check, { worktree: last })
  const failing = ran.ok ? 0 : (Number((/(\d+)\s+(?:failed|failing|fail|errors?)\b/i.exec(ran.tail) || [])[1]) || 1)
  const review = ran.ok ? await workflow('review-changes', { worktreeFrom: last, maxVerify: 10 }) : null
  const blocking = review ? (review.findings || []).filter((f) => f.priority === 'P0' || f.priority === 'P1') : []
  result = { check: { command: check, ok: ran.ok, tail: ran.tail }, review: review ? { verdict: review.verdict, report: review.report } : null }
  if (ran.ok && !blocking.length) break
  if (round >= 3) {
    log('Stopped after 3 fix rounds')
    break
  }
  // progress check: the failing count must fall, or the findings must change
  const progressing = failing < previousFailing
  previousFailing = failing
  if (!progressing) stalls++
  if (stalls >= 3 && !replanned) {
    replanned = true
    stalls = 0
    log('Three rounds without progress: planning again once')
    phase('Plan')
    plan = await makePlan(lib.fence('what-failed', ran.tail + '\n' + blocking.map((f) => f.file + ':' + f.line + ' ' + f.title).join('\n')))
    if (!plan) break
  } else if (stalls >= 3) {
    log('Still no progress after a re-plan; stopping')
    break
  }
  phase('Fix')
  const fix = await build(
    { title: 'fix round ' + (round + 1), files: [...new Set(blocking.map((f) => f.file))], check },
    last,
    lib.fence('check-output', ran.tail) + (blocking.length ? '\n\n' + lib.fence('review-findings', blocking.map((f) => ({ file: f.file, line: f.line, title: f.title, scenario: f.scenario }))) : ''),
  )
  if (fix && fix.worktree && fix.worktree.commit) last = fix.seq
}
const branch = await lib.diff(last)
return {
  done: !!(result && result.check.ok && (!result.review || !(result.review.verdict || '').startsWith('changes needed'))),
  task,
  plan: planText,
  decided: answers,
  ...result,
  branchCall: last,
  note: 'The change is on the kept branch of call ' + last + '. Offer the owner Merge or Diff from the run view.',
  diffChars: branch.length,
}
