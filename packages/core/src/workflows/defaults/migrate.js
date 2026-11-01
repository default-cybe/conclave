export const meta = {
  name: 'migrate',
  description: 'A codebase migration: discover the sites, pilot one unit and write a playbook, then escalating batches (4, 8, 16) in separate worktrees with a per-batch circuit breaker; returns re-passable remaining, failed and blocked lists',
  whenToUse: 'For the same change across many files or packages (an API rename, a framework upgrade). args: { goal: string, check: the per-unit build or test command (use {unit} for the unit path), units?: [{ name, path, deps? }] to skip discovery }',
  runtime: 'conclave',
  phases: [{ title: 'Discover' }, { title: 'Pilot' }, { title: 'Approve' }, { title: 'Migrate' }, { title: 'Report' }],
}

const A = args && typeof args === 'object' ? args : {}
const goal = String(A.goal || '').trim()
const check = String(A.check || '').trim()
if (!goal || !check) throw new Error('migrate needs args.goal and args.check')
const checkFor = (u) => check.split('{unit}').join(u.path)

phase('Discover')
let units = Array.isArray(A.units) ? A.units : null
if (!units) {
  const unitSchema = { type: 'object', properties: { units: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string' }, deps: { type: 'array', items: { type: 'string' } } }, required: ['name', 'path'] } } }, required: ['units'] }
  const found = await parallel(['by search: every call site and import the goal touches', 'by package: each package or module folder that needs the change', 'by build graph: which units depend on which'].map((angle, i) => () =>
    agent(['List the units this migration must change, one per package or folder, with their sibling dependencies by name. Read the code; do not change it.', 'Your angle: ' + angle, lib.fence('goal', goal)].join('\n\n'), { label: 'discover ' + (i + 1), phase: 'Discover', agentType: 'explore', schema: unitSchema }),
  ))
  const byName = new Map()
  for (const r of found.filter(Boolean)) for (const u of r.units) {
    const have = byName.get(u.name)
    byName.set(u.name, have ? { ...have, deps: [...new Set([...(have.deps || []), ...(u.deps || [])])] } : { name: u.name, path: u.path, deps: u.deps || [] })
  }
  units = [...byName.values()]
}
if (!units.length) return { done: true, note: 'no units need this migration' }
log(units.length + ' units: ' + units.map((u) => u.name).join(', '))

const result = (r, u) => (r && r.value ? { unit: u.name, path: u.path, deps: u.deps || [], built: !!r.value.built, buildRan: !!r.value.buildRan, gaps: r.value.gaps || [], seq: r.seq } : { unit: u.name, path: u.path, deps: u.deps || [], built: false, buildRan: false, gaps: [], error: 'no result' })
const RESULT = { type: 'object', properties: { built: { type: 'boolean' }, buildRan: { type: 'boolean' }, buildCommand: { type: 'string' }, gaps: { type: 'array', items: { type: 'string' } }, filesChanged: { type: 'array', items: { type: 'string' } } }, required: ['built', 'buildRan'] }
const migrateOne = (u, playbook, gaps, phaseName) =>
  agent(
    [
      'Migrate one unit. Edit only inside ' + u.path + '. Follow the playbook; report every gap it did not cover, even ones you solved. Then run the unit check and report honestly: buildRan is true only if you ran it, built only if it passed.',
      lib.fence('goal', goal),
      playbook ? lib.fence('playbook', playbook) : '',
      gaps.length ? lib.fence('gaps-from-earlier-batches', gaps.join('\n')) : '',
      'Unit check: ' + checkFor(u),
    ].filter(Boolean).join('\n\n'),
    { label: 'migrate ' + u.name, phase: phaseName, agentType: 'builder', schema: RESULT, isolation: 'worktree', conclave: { withMeta: true } },
  )

phase('Pilot')
const pilotUnit = units.find((u) => !(u.deps || []).length) || units[0]
const pilot = await migrateOne(pilotUnit, '', [], 'Pilot')
const pilotResult = result(pilot, pilotUnit)
const playbook = await agent(
  ['Write PLAYBOOK.md for this migration from the pilot: the ordered edits, every error hit and its fix, environment facts, and the exact check that proves a unit is done. Short lines.', lib.fence('goal', goal), lib.fence('pilot', { unit: pilotUnit, result: pilotResult, diff: pilot ? (await lib.diff(pilot.seq)).slice(0, 30000) : '' })].join('\n\n'),
  { label: 'playbook', phase: 'Pilot', model: 'smart' },
)

phase('Approve')
if (!(await lib.approve('Pilot of ' + pilotUnit.name + ': ' + (pilotResult.built ? 'built' : 'did not build') + '.\n\nPlaybook:\n' + playbook + '\n\nFan out over ' + (units.length - 1) + ' more units?'))) {
  return { done: false, stopped: 'the owner did not approve the fan-out', pilot: pilotResult, playbook }
}

phase('Migrate')
const done = [pilotResult]
const remaining = units.filter((u) => u !== pilotUnit)
const gaps = pilotResult.gaps.slice()
const names = new Set(units.map((u) => u.name))
let aborted = null
for (let batchNum = 1; remaining.length && !aborted; batchNum++) {
  const built = new Set(done.filter((r) => r.built).map((r) => r.unit))
  const eligible = remaining.filter((u) => (u.deps || []).every((d) => built.has(d) || !names.has(d)))
  if (!eligible.length) break
  const size = batchNum === 1 ? 4 : batchNum === 2 ? 8 : 16
  const batch = eligible.slice(0, size)
  for (const u of batch) remaining.splice(remaining.indexOf(u), 1)
  log('Batch ' + batchNum + ': ' + batch.map((u) => u.name).join(', '))
  const got = await parallel(batch.map((u) => () => migrateOne(u, playbook, gaps, 'Migrate')))
  const results = batch.map((u, i) => result(got[i], u))
  done.push(...results)
  for (const g of results.flatMap((r) => r.gaps)) if (!gaps.includes(g)) gaps.push(g)
  const measured = results.filter((r) => r.buildRan)
  const ok = measured.filter((r) => r.built).length
  log('Batch ' + batchNum + ': ' + ok + ' of ' + measured.length + ' measured units built')
  if (remaining.length && measured.length && ok * 3 < measured.length * 2) aborted = 'batch ' + batchNum + ' built ' + ok + ' of ' + measured.length + ' (under 2 of 3); fix the playbook with the gaps before going on'
  else if (remaining.length && !measured.length) aborted = 'no unit in batch ' + batchNum + ' could run its check'
  if (aborted) log('Circuit breaker: ' + aborted)
}

phase('Report')
const failed = done.filter((r) => !r.built)
const doomed = new Set(failed.map((r) => r.unit))
let grew = true
while (grew) {
  grew = false
  for (const u of units) if (!doomed.has(u.name) && (u.deps || []).some((d) => doomed.has(d))) (doomed.add(u.name), (grew = true))
}
const blocked = remaining.filter((u) => doomed.has(u.name))
const notAttempted = remaining.filter((u) => !doomed.has(u.name))
const asUnit = (u) => ({ name: u.name || u.unit, path: u.path, ...((u.deps || []).length ? { deps: u.deps } : {}) })
return {
  goal,
  playbook,
  results: done,
  abortedEarly: !!aborted,
  abortReason: aborted,
  remainingUnits: notAttempted.map(asUnit),
  failedUnits: failed.map(asUnit),
  blockedUnits: blocked.map(asUnit),
  gaps,
  note: 'Each built unit is on its own kept branch (results[].seq). Merge them from the run view.',
}
