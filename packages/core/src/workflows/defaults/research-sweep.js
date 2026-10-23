export const meta = {
  name: 'research-sweep',
  description: 'Map a codebase before a design: explorers split by subsystem, by entity, by history and by tests, each anchored at file:line, then one merged map and a list of what nobody read',
  whenToUse: 'Before you design or plan a change in code you do not know yet. Cheaper than deep-research. args: { question: string, entities?: string[], areas?: string[] }',
  runtime: 'conclave',
  phases: [{ title: 'Split' }, { title: 'Explore' }, { title: 'Merge' }, { title: 'Critic' }],
}

const A = typeof args === 'string' ? { question: args } : args && typeof args === 'object' ? args : {}
const question = String(A.question || '').trim()
if (!question) throw new Error('research-sweep needs args.question')

// ---------- Split ----------
phase('Split')
// a plain file list (read-only, so it never asks); folders two levels deep are counted here
const perArea = {}
for (const f of (await lib.exec('git ls-files')).stdout.split('\n').filter(Boolean)) {
  const p = f.split('/')
  const k = p.length > 2 ? p[0] + '/' + p[1] : p.length === 2 ? p[0] : '.'
  perArea[k] = (perArea[k] || 0) + 1
}
const areas = Array.isArray(A.areas) && A.areas.length
  ? A.areas
  : Object.entries(perArea).sort((a, b) => b[1] - a[1]).map(([k]) => k).filter((x) => x !== '.').slice(0, 6)
let entities = Array.isArray(A.entities) ? A.entities : []
if (!entities.length) {
  const e = await agent(
    'Name the 2 to 4 types, functions, routes or config keys this question is about, as they would appear in code. Guess from the words; do not search.\n\n' + lib.fence('question', question),
    { label: 'entities', phase: 'Split', model: 'fast', schema: { type: 'object', properties: { entities: { type: 'array', items: { type: 'string' } } }, required: ['entities'] } },
  )
  entities = e ? e.entities.slice(0, 4) : []
}
log('Areas: ' + areas.join(', ') + '. Entities: ' + (entities.join(', ') || 'none'))

const mapSchema = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      items: { type: 'object', properties: { file: { type: 'string' }, line: { type: 'integer' }, what: { type: 'string' } }, required: ['file', 'what'] },
    },
    summary: { type: 'string' },
    read: { type: 'array', items: { type: 'string' } },
    notReached: { type: 'array', items: { type: 'string' } },
  },
  required: ['entries', 'summary'],
}
const brief = (how) =>
  [
    'Explore the code to answer part of a question. Read what you cite; anchor every entry at file:line. Thoroughness: medium.',
    'Your angle: ' + how,
    lib.fence('question', question),
    'Return the map through StructuredOutput: entries (file, line, what is there and why it matters), a short summary, what you read and what you did not reach.',
  ].join('\n\n')
const angles = [
  ...areas.map((a) => ({ label: 'area ' + a, how: 'the subsystem under ' + a + ': its entry points, data flow and the parts that touch the question' })),
  ...entities.map((e) => ({ label: 'entity ' + e, how: 'the entity ' + e + ': where it is defined, every place that creates, reads or changes it' })),
  { label: 'history', how: 'history: git log and git blame on the files the question touches; recent changes, reverts and their messages' },
  { label: 'tests', how: 'tests: which tests pin the behavior the question is about, and what they leave out' },
]

// ---------- Explore ----------
phase('Explore')
const maps = (await pipeline(angles, (a) => agent(brief(a.how), { label: a.label, phase: 'Explore', agentType: 'explore', schema: mapSchema }).then((r) => (r ? { angle: a.label, ...r } : null)))).filter(Boolean)
if (maps.length < angles.length) log((angles.length - maps.length) + ' of ' + angles.length + ' explorers returned nothing')

// ---------- Merge ----------
phase('Merge')
const merged = await agent(
  [
    'Merge these code maps into one map for the question: group by subsystem, drop duplicates, keep every file:line anchor. Then list open questions the maps do not answer.',
    lib.fence('question', question),
    lib.fence('maps', maps.map((m) => ({ angle: m.angle, summary: m.summary, entries: m.entries }))),
  ].join('\n\n'),
  { label: 'merge', phase: 'Merge', model: 'smart' },
)

// ---------- Critic ----------
phase('Critic')
const read = [...new Set(maps.flatMap((m) => m.read || []))]
const notReached = [...new Set(maps.flatMap((m) => m.notReached || []))].filter((f) => !read.includes(f))
const critic = await agent(
  [
    'List the areas of the code a design for this question would need that nobody read yet. Only what would change the design. One line each.',
    lib.fence('question', question),
    lib.fence('read', read.join('\n')),
    lib.fence('map', merged || ''),
  ].join('\n\n'),
  { label: 'critic', phase: 'Critic', model: 'smart', schema: { type: 'object', properties: { unread: { type: 'array', items: { type: 'string' } } }, required: ['unread'] } },
)
return { question, map: merged, entries: maps.flatMap((m) => m.entries), coverage: { read, notReached, unread: critic ? critic.unread : [] } }
