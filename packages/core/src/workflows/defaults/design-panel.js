export const meta = {
  name: 'design-panel',
  description: 'Four independent designs from fixed angles, scored blind by three judges in both orders, then one design built from the winner with named ideas grafted from the others',
  whenToUse: 'When a design choice is open and wide: an API, a data model, a feature shape. args: { request: string, context?: string }',
  runtime: 'conclave',
  phases: [{ title: 'Rubric' }, { title: 'Design' }, { title: 'Judge' }, { title: 'Synthesize' }],
}

const A = typeof args === 'string' ? { request: args } : args && typeof args === 'object' ? args : {}
const request = String(A.request || '').trim()
if (!request) throw new Error('design-panel needs args.request')

phase('Rubric')
const rubric = await agent(
  ['Write a scoring rubric for designs that answer this request: 4 to 6 criteria taken from the request itself, each one line, most important first.', lib.fence('request', request)].join('\n\n'),
  { label: 'rubric', phase: 'Rubric', model: 'smart' },
)

phase('Design')
const ANGLES = ['the smallest change that meets the request', 'risk first: what could go wrong, and the design that avoids it', 'the owner\'s ergonomics first: how it feels to use every day', 'performance and cost first']
const designs = await parallel(ANGLES.map((angle, i) => () =>
  agent(
    [
      'Design an answer to this request from one angle. Read the code it touches first. Give the design, its parts, what it changes, its risks, and how to test it. Under 600 words.',
      'Your angle: ' + angle,
      lib.fence('request', request),
      A.context ? lib.fence('context', A.context) : '',
    ].filter(Boolean).join('\n\n'),
    { label: 'design ' + (i + 1), phase: 'Design', agentType: 'planner' },
  ),
))
const usable = designs.map((d, i) => ({ d, angle: ANGLES[i] })).filter((x) => x.d)
if (usable.length < 2) return { design: usable[0] ? usable[0].d : null, note: 'fewer than two designs came back, so nothing was judged' }

phase('Judge')
const panel = await lib.judgePanel(usable.map((x) => x.d), { judges: 3, rubric: rubric || 'Correctness, then simplicity, then the owner\'s ergonomics.', phase: 'Judge' })
const win = panel.winner !== null ? panel.winner : panel.scores.indexOf(Math.max(...panel.scores))
log('Winner: design ' + (win + 1) + ' (' + usable[win].angle + '); votes ' + panel.votes.join(', ') + ', ' + panel.ties + ' order flips')

phase('Synthesize')
const final = await agent(
  [
    'Write the final design as a DESIGN.md entry: a heading, the decision in one paragraph, the parts, what changes, risks and how it is tested. Build it from the winning design and graft in named ideas from the others where they make it better; say which idea came from where.',
    'Short plain sentences. No em dashes.',
    lib.fence('request', request),
    lib.fence('winner', usable[win].d),
    lib.fence('others', usable.filter((_, i) => i !== win).map((x, i) => '## Other design ' + (i + 1) + ' (' + x.angle + ')\n' + x.d).join('\n\n')),
  ].join('\n\n'),
  { label: 'synthesize', phase: 'Synthesize', model: 'smart' },
)
return { design: final, winner: { angle: usable[win].angle, votes: panel.votes, scores: panel.scores }, rubric }
