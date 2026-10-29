export const meta = {
  name: 'web-studio',
  description: 'Build a new site that does not look AI-made, following the web-studio skill: a design read, references by lane, a spec you approve, signature prototypes you pick from, a parallel build, a screenshot judge on a 10-point rubric for up to 3 rounds, then two validation rounds that keep the findings ledger',
  whenToUse: 'For a new site, landing page or portfolio, or a full redesign, in any project folder. Not for a small change in an existing design (use ui-pass). It stops twice for you: approve the spec, then pick a prototype. Large: about 25 to 45 agents and 1 to 3 million output tokens. args: { brief: string, dir: the project folder, url?: the running site (else an agent starts one), references?: [links you collected], prototypes?: 3 to 6, round?: the ledger round, default one past the highest }',
  runtime: 'conclave',
  estimate: { agents: 35, tokens: 2000000 },
  phases: [{ title: 'Read' }, { title: 'References' }, { title: 'Spec' }, { title: 'Options' }, { title: 'Build' }, { title: 'Look' }, { title: 'Validate' }],
}

const A = args && typeof args === 'object' ? args : {}
const brief = String(A.brief || '').trim()
if (!brief) throw new Error('web-studio needs args.brief')
const dirArg = typeof A.dir === 'string' ? A.dir.trim() : ''
if (!dirArg) throw new Error('web-studio needs args.dir, the project folder')
const references = (Array.isArray(A.references) ? A.references : []).filter((u) => typeof u === 'string' && /^https?:\/\//.test(u)).slice(0, 20)
const nProto = Math.min(6, Math.max(3, Number.isInteger(A.prototypes) ? A.prototypes : 3))
const MAX_ROUNDS = 3
const RUBRIC = ['First glance', 'Signature', 'Typography', 'Composition', 'Colour', 'Media', 'Motion', 'Mobile', 'Copy', 'Polish']
const SKILL = 'Load the web-studio skill first (Skill tool, skill "web-studio") and follow it. Short plain sentences, no em dashes.'

// the folder as an absolute path, so agents, worktrees and the ledger agree on it
const where = await lib.exec('pwd', { cwd: dirArg })
if (where.exitCode !== 0) throw new Error('args.dir is not a folder on this device: ' + dirArg)
const root = where.stdout.trim()
const at = (extra) => ({ conclave: { cwd: root, ...(extra || {}) } })
const isGit = (await lib.exec('git rev-parse --is-inside-work-tree', { cwd: root })).stdout.trim() === 'true'

/** The pass bar, in code: every rubric area scored, an average of 8 or more and nothing under 7. A missing area counts as 0. */
const scoreBar = (scores) => {
  const list = Array.isArray(scores) ? scores : []
  const by = RUBRIC.map((area) => {
    const s = list.find((x) => x && x.area === area)
    const n = s && typeof s.score === 'number' && Number.isFinite(s.score) ? Math.max(1, Math.min(10, s.score)) : 0
    return { area, score: n, why: s ? String(s.why || '') : 'not scored', fix: s ? String(s.fix || '') : '' }
  })
  const avg = Math.round((by.reduce((t, x) => t + x.score, 0) / by.length) * 100) / 100
  const min = Math.min(...by.map((x) => x.score))
  return { avg, min, passed: avg >= 8 && min >= 7, weakest: [...by].sort((a, b) => a.score - b.score).slice(0, 3), scores: by }
}

phase('Read')
const read = await agent(
  [
    'Write the design read for this site, as in phase 0 of the web-studio skill: one "Reading this as: ..." line, the three dials (VARIANCE, MOTION, DENSITY, 1 to 10), the one signature idea the page will be remembered for, 2 to 4 quiet supports, and the assumptions you made instead of asking. Read the project folder first; change nothing.',
    SKILL,
    lib.fence('brief', brief),
    references.length ? lib.fence('owner-references', references.join('\n')) : '',
  ].filter(Boolean).join('\n\n'),
  {
    label: 'design read',
    phase: 'Read',
    model: 'smart',
    schema: {
      type: 'object',
      properties: {
        read: { type: 'string' },
        dials: { type: 'object', properties: { variance: { type: 'number' }, motion: { type: 'number' }, density: { type: 'number' } }, required: ['variance', 'motion', 'density'] },
        signature: { type: 'string' },
        supports: { type: 'array', items: { type: 'string' } },
        assumptions: { type: 'array', items: { type: 'string' } },
      },
      required: ['read', 'dials', 'signature'],
    },
    ...at(),
  },
)
if (!read) return { passed: false, stopped: 'the design read returned nothing' }
log('Design Read: ' + read.read + ' | dials ' + [read.dials.variance, read.dials.motion, read.dials.density].join('/') + ' | signature: ' + read.signature)
const readText = 'Design Read: ' + read.read + '\nDials: VARIANCE ' + read.dials.variance + ', MOTION ' + read.dials.motion + ', DENSITY ' + read.dials.density + '\nSignature: ' + read.signature + (read.supports && read.supports.length ? '\nSupports: ' + read.supports.join('; ') : '')

phase('References')
// owner links first, then one researcher per lane
const LANES = [
  ...(references.length ? [{ id: 'owner links', text: 'the owner\'s own links, below. Open every one; for an x.com post use https://api.fxtwitter.com/<user>/status/<id>', links: references }] : []),
  { id: 'same field', text: 'sites in the same field as this brief' },
  { id: 'portfolios', text: 'strong personal portfolios and studio sites' },
  { id: 'effects', text: 'effects that could carry the signature idea (Codrops, three.js journey, shaders, canvas)' },
  { id: 'motion and CSS', text: 'motion and CSS references: scroll-driven animations, View Transitions, easing curves' },
  { id: 'colour', text: 'colour: OKLCH palettes and Radix-style scales that fit the dials' },
]
const lanes = await parallel(LANES.map((l) => () =>
  agent(
    [
      'Find references for one lane of a site design. Return 3 to 5 sources, each with its URL, the one technique worth taking (layout, rhythm or motion grammar, never content, logos or copy), and a screenshot or contact sheet path when you made one. Open every page you cite.',
      SKILL,
      'Your lane: ' + l.text,
      l.links ? lib.fence('owner-links', l.links.join('\n')) : '',
      lib.fence('design-read', readText),
      lib.fence('brief', brief),
    ].filter(Boolean).join('\n\n'),
    {
      label: 'refs ' + l.id,
      phase: 'References',
      agentType: 'researcher',
      schema: { type: 'object', properties: { sources: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, technique: { type: 'string' }, evidence: { type: 'string' } }, required: ['url', 'technique'] } } }, required: ['sources'] },
    },
  ),
))
const sources = LANES.flatMap((l, i) => (lanes[i] && lanes[i].sources ? lanes[i].sources.map((s) => ({ lane: l.id, ...s })) : []))
log(sources.length + ' references from ' + lanes.filter(Boolean).length + ' of ' + LANES.length + ' lanes')

phase('Spec')
const spec = await agent(
  [
    'Write the spec for this site before any code, as in phase 2 of the web-studio skill. In the project folder write research/STYLE.md (palette in OKLCH with contrast checked, type scale, a closed spacing set, radius system, motion tokens), research/SPEC.md (per section, every element with values, not adjectives, a motion state list on a beat grid, and a fidelity clause: build nothing that is not listed) and research/SOURCES.md (every reference link used). Split the build into 2 to 8 modules with a mount(host, env) contract returning { destroy, update, rewind? }; one module is the signature. Write no site code.',
    SKILL,
    lib.fence('design-read', readText),
    lib.fence('references', sources.map((s) => '- [' + s.lane + '] ' + s.url + ': ' + s.technique + (s.evidence ? ' (' + s.evidence + ')' : '')).join('\n') || 'none came back'),
    lib.fence('brief', brief),
  ].join('\n\n'),
  {
    label: 'spec',
    phase: 'Spec',
    agentType: 'designer',
    model: 'smart',
    schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'The spec in under 200 words, for the owner to approve' },
        modules: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, does: { type: 'string' }, signature: { type: 'boolean' } }, required: ['name', 'does'] } },
      },
      required: ['summary', 'modules'],
    },
    ...at(),
  },
)
if (!spec) return { passed: false, stopped: 'the spec agent returned nothing', read }
const modules = (spec.modules || []).filter((m) => m && m.name).slice(0, 8)
const approved = await lib.approve(
  [
    'web-studio: approve the spec before any code is written.',
    readText,
    'Spec files: ' + root + '/research/STYLE.md, SPEC.md and SOURCES.md',
    spec.summary,
    'Modules:\n' + modules.map((m) => '- ' + m.name + (m.signature ? ' (signature)' : '') + ': ' + m.does).join('\n'),
  ].join('\n\n'),
)
if (!approved) return { passed: false, approved: false, stopped: 'the owner did not approve the spec', read, spec: spec.summary, modules }
// the locked STYLE.md, as the judges and builders see it from here on
const styleFile = await lib.exec('cat research/STYLE.md', { cwd: root })
const style = styleFile.exitCode === 0 ? styleFile.stdout.slice(0, 20000) : ''
if (!style) log('research/STYLE.md could not be read; the judge scores without it')

phase('Options')
const ANGLES = ['the most restrained version that still lands', 'the boldest version the dials allow', 'type-led: the idea carried by typography', 'motion-led: the idea carried by movement on scroll', 'material-led: texture, grain or light', 'interaction-led: the idea answers the pointer']
const shotSchema = { type: 'object', properties: { page: { type: 'string', description: 'The page to open, relative to the project folder' }, screenshots: { type: 'array', items: { type: 'string', description: 'Absolute paths of the PNGs' } }, note: { type: 'string' } }, required: ['page', 'screenshots'] }
const protos = (await parallel(ANGLES.slice(0, nProto).map((angle, i) => () =>
  agent(
    [
      'Build one prototype of the signature idea as a full real page, against research/STYLE.md. ' + (isGit ? 'Build it in this worktree' : 'Build it only inside prototypes/option-' + (i + 1) + '/') + '. Then take screenshots at 390 and 1440 wide, light and dark, look at them, and return the page and the PNG paths.',
      SKILL,
      'Your angle: ' + angle,
      lib.fence('design-read', readText),
      lib.fence('brief', brief),
    ].join('\n\n'),
    { label: 'prototype ' + (i + 1), phase: 'Options', agentType: 'designer', schema: shotSchema, ...(isGit ? { isolation: 'worktree' } : {}), ...at({ withMeta: true }) },
  ).then((r) => (r && r.value ? { option: i + 1, angle, ...r.value, branch: r.worktree && r.worktree.commit ? r.worktree.branch : undefined } : null)),
))).filter(Boolean)
if (!protos.length) return { passed: false, stopped: 'no prototype came back', read, spec: spec.summary }
let ranked = protos
if (protos.length > 1) {
  const critic = await agent(
    [
      'Rank these prototypes of the signature idea from their screenshots only. Score each 1 to 10 for how memorable, how well it fits the design read and STYLE.md, and how much it avoids the web-studio ban list. Open every screenshot with Read.',
      lib.fence('design-read', readText),
      lib.fence('style', style || 'not available'),
      lib.fence('prototypes', protos.map((p) => 'Option ' + p.option + ' (' + p.angle + '): ' + p.screenshots.join(', ')).join('\n')),
    ].join('\n\n'),
    {
      label: 'critic',
      phase: 'Options',
      model: 'smart',
      schema: { type: 'object', properties: { ranking: { type: 'array', items: { type: 'object', properties: { option: { type: 'integer' }, score: { type: 'number' }, reason: { type: 'string' } }, required: ['option', 'score', 'reason'] } } }, required: ['ranking'] },
      conclave: { tools: ['Read'] },
    },
  )
  const order = critic && Array.isArray(critic.ranking) ? critic.ranking : []
  const scoreOf = (p) => { const r = order.find((x) => x.option === p.option); return r ? r.score : -1 }
  ranked = [...protos].sort((a, b) => scoreOf(b) - scoreOf(a)).map((p) => ({ ...p, score: scoreOf(p), reason: (order.find((x) => x.option === p.option) || {}).reason }))
}
const labelOf = (p) => 'Option ' + p.option + ': ' + p.angle.split(':')[0] + (p.score >= 0 ? ' (critic ' + p.score + '/10)' : '')
const pickLabel = await lib.ask(
  'Which signature prototype should the site use? ' + ranked.map((p) => labelOf(p) + ': open ' + p.page + (p.branch ? ' on branch ' + p.branch : '')).join('; '),
  ranked.map(labelOf),
)
const picked = ranked.find((p) => labelOf(p) === pickLabel) || ranked[0]
log('Picked option ' + picked.option + ' (' + picked.angle + ')')
const pickedText = 'The owner picked prototype option ' + picked.option + ' (' + picked.angle + '): page ' + picked.page + (picked.branch ? ' on git branch ' + picked.branch + ' (read it with git show or git diff; do not merge the other prototype branches)' : ' in this folder')

phase('Build')
const work = modules.length ? modules : [{ name: 'page', does: 'the whole page as SPEC.md lists it', signature: true }]
const built = await parallel(work.map((m) => () =>
  agent(
    [
      'Build one module of the site against the locked research/STYLE.md and research/SPEC.md. Do not edit STYLE.md or SPEC.md. Touch only this module\'s files. Use the mount(host, env) contract returning { destroy, update, rewind? }; effects replay when scrolled back into view; respect prefers-reduced-motion.',
      SKILL,
      'Your module: ' + m.name + ': ' + m.does + (m.files && m.files.length ? '\nFiles: ' + m.files.join(', ') : ''),
      m.signature ? pickedText + '. Port it into this module.' : '',
    ].filter(Boolean).join('\n\n'),
    { label: 'module ' + m.name, phase: 'Build', agentType: 'builder', ...at() },
  ),
))
log(built.filter(Boolean).length + ' of ' + work.length + ' modules built')
const assembled = await agent(
  [
    'Assemble the site from its modules: wire every module into the page as research/SPEC.md says, fix the seams between them, and make the project build. Do not edit research/STYLE.md. Report what is missing.',
    SKILL,
    'Modules: ' + work.map((m) => m.name).join(', '),
    pickedText,
  ].join('\n\n'),
  { label: 'assemble', phase: 'Build', agentType: 'builder', ...at() },
)
if (!assembled) log('the assemble step returned nothing; looking at what was built')

phase('Look')
// the running site: the owner's URL, else an agent starts the project's own dev server or a static server
let url = typeof A.url === 'string' && /^https?:\/\//.test(A.url) ? A.url : ''
let serve = null
if (!url) {
  serve = await agent(
    [
      'Start this project so a browser can open it. Use the project\'s own dev or preview script when it has one; for plain HTML start a static server (for example python3 -m http.server). Bind to 127.0.0.1 on a free port, run it in the background so it outlives you, check it answers with curl, and return the URL and the command that stops it. Change no files.',
    ].join('\n\n'),
    { label: 'serve', phase: 'Look', agentType: 'builder', schema: { type: 'object', properties: { url: { type: 'string' }, stop: { type: 'string' } }, required: ['url'] }, ...at() },
  )
  url = serve && /^https?:\/\//.test(serve.url || '') ? serve.url : ''
}
if (!url) return { passed: false, stopped: 'no URL to look at: pass args.url, or start the site and run again', read, spec: spec.summary, picked: pickedText }

const ledger = await lib.ledger.read(root)
const ledgerRound = Number.isInteger(A.round) ? A.round : ledger.reduce((m, e) => Math.max(m, e.round), 0) + 1
const ledgerText = lib.ledger.fence(ledger)
const closed = new Map(ledger.filter((e) => e.verdict !== 'open').map((e) => [e.id, e.verdict]))
const isClosed = (f) => { const v = closed.get(lib.ledger.id(f.title)); return v === 'rejected' || v === 'wontfix' || (v === 'fixed' && f.regressed !== true) }

const evidenceOf = (cap) => (cap.results || []).flatMap((r) => [...(r.shots || []).flatMap((s) => [s.png, s.early].filter(Boolean)), ...Object.values(r.sheets || {}).flat()])
// machine checks that stop a round before scoring, from the capture report
const blockersOf = (cap) => {
  const out = []
  for (const r of cap.results || []) {
    if (r.error) { out.push(r.browser + ': ' + r.error); continue }
    const s = r.summary || {}
    if (s.consoleErrors) out.push(r.browser + ': ' + s.consoleErrors + ' console errors (' + r.report + ')')
    if (s.failedRequests) out.push(r.browser + ': ' + s.failedRequests + ' failed requests (' + r.report + ')')
    for (const [w, px] of Object.entries(s.overflow || {})) if (px > 0) out.push(r.browser + ': horizontal overflow at ' + w + ' wide (' + px + ')')
    const serious = (s.axe || []).filter((v) => v.impact === 'serious' || v.impact === 'critical')
    if (serious.length) out.push(r.browser + ': axe ' + serious.map((v) => v.id + ' (' + v.nodes + ')').join(', '))
  }
  if (!evidenceOf(cap).length) out.push('the capture made no screenshots')
  return out
}
const scoreSchema = {
  type: 'object',
  properties: {
    scores: {
      type: 'array',
      items: { type: 'object', properties: { area: { type: 'string', enum: RUBRIC }, score: { type: 'number', minimum: 1, maximum: 10 }, why: { type: 'string' }, fix: { type: 'string', description: 'The change, with values, that would raise it' } }, required: ['area', 'score', 'why'] },
    },
  },
  required: ['scores'],
}

const rounds = []
let cap = null
let stopped = ''
for (let r = 1; r <= MAX_ROUNDS; r++) {
  try {
    cap = await lib.capture(url, { widths: [390, 1440], themes: ['light', 'dark'], earlyFrame: 0.35, scroll: true })
  } catch (e) {
    stopped = 'capture failed: ' + (e && e.message ? e.message : String(e))
    break
  }
  const blockers = blockersOf(cap)
  let bar = null
  if (!blockers.length) {
    // a fresh judge that sees only the screenshots, contact sheets, brief and STYLE.md
    const judged = await agent(
      [
        'Score this site on the 10-point rubric of the web-studio skill, from the screenshots and contact sheets only. Score every area from 1 to 10: ' + RUBRIC.join(', ') + '. Most first drafts land at 6 to 7; give 8 or more only when a screenshot shows it. For each area say why and the change, with values, that would raise it. Open every file with Read.',
        lib.fence('brief', brief),
        lib.fence('style', style || 'not available'),
        'Screenshots and contact sheets: ' + evidenceOf(cap).join(', '),
        ledgerText,
      ].filter(Boolean).join('\n\n'),
      { label: 'judge r' + r, phase: 'Look', model: 'smart', schema: scoreSchema, conclave: { tools: ['Read'] } },
    )
    bar = scoreBar(judged ? judged.scores : [])
  }
  rounds.push({ round: r, blockers, ...(bar ? { avg: bar.avg, min: bar.min, passed: bar.passed, weakest: bar.weakest, scores: bar.scores } : { passed: false }), capture: cap.dir })
  log('Look round ' + r + ': ' + (bar ? 'average ' + bar.avg + ', lowest ' + bar.min + (bar.passed ? ', passes' : ', under the bar') : blockers.length + ' blocking machine checks'))
  if (bar && bar.passed) break
  if (r === MAX_ROUNDS) break
  const todo = bar ? bar.weakest.map((w) => w.area + ' ' + w.score + '/10: ' + w.why + (w.fix ? ' Fix: ' + w.fix : '')) : blockers
  await agent(
    [
      bar ? 'Raise the 3 weakest rubric areas of this site with values, not adjectives. Keep research/STYLE.md; when a fix needs a new token, add it there and say so.' : 'Fix the blocking machine checks of this site first: console errors, failed requests, horizontal overflow and serious axe violations.',
      SKILL,
      lib.fence(bar ? 'judge-weakest' : 'blocking-checks', todo.join('\n')),
      'Capture report folder: ' + cap.dir,
    ].join('\n\n'),
    { label: 'fix r' + r, phase: 'Look', agentType: 'designer', ...at() },
  )
}
const last = rounds[rounds.length - 1]
const lookPassed = !!(last && last.passed)

phase('Validate')
const checkCmds = await (async () => {
  const pkg = await lib.exec('cat package.json', { cwd: root })
  if (pkg.exitCode !== 0) return []
  let scripts = {}
  try { scripts = JSON.parse(pkg.stdout).scripts || {} } catch (e) { return [] }
  const files = (await lib.exec('ls -a', { cwd: root })).stdout.split('\n').map((f) => f.trim())
  const pm = files.includes('bun.lock') || files.includes('bun.lockb') ? 'bun' : files.includes('pnpm-lock.yaml') ? 'pnpm' : files.includes('yarn.lock') ? 'yarn' : 'npm'
  return ['typecheck', 'lint', 'test', 'build'].filter((s) => typeof scripts[s] === 'string' && !/no test specified/.test(scripts[s])).map((s) => pm + ' run ' + s)
})()
const checks = []
for (const c of checkCmds) {
  const r = await lib.runCheck('cd ' + lib.shq(root) + ' && ' + c)
  checks.push({ command: c, ok: r.ok, tail: r.ok ? '' : r.tail.split('\n').slice(-8).join('\n') })
}
if (!checkCmds.length) log('no typecheck, lint, test or build script in package.json; the QA lens looks for the project\'s own check')

const findingsSchema = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, severity: { type: 'string', enum: ['high', 'medium', 'low'] }, evidence: { type: 'string', description: 'A screenshot path, URL, selector or file:line' }, fix: { type: 'string' }, regressed: { type: 'boolean', description: 'A ledger item marked fixed that your evidence shows came back' } }, required: ['title', 'severity', 'evidence'] } },
  },
  required: ['findings'],
}
const evidence = cap ? 'Latest capture (screenshots, contact sheets, report.json): ' + cap.dir : 'No capture was made.'
const validate = async (round, lenses) => {
  const out = await parallel(lenses.map((l) => () =>
    agent(
      [
        'Review this site through one lens and report only real problems, each with a severity and evidence you checked. Change no files.',
        SKILL,
        'Your lens: ' + l.text,
        'Site: ' + url + '\nProject folder: ' + root + '\n' + evidence,
        lib.fence('brief', brief),
        l.extra || '',
        ledgerText,
      ].filter(Boolean).join('\n\n'),
      { label: round + ' ' + l.id, phase: 'Validate', agentType: l.agentType, schema: findingsSchema, ...at() },
    ).then((r) => (r ? (r.findings || []).map((f) => ({ ...f, lens: l.id })) : [])),
  ))
  // two lenses that report the same problem give one finding, by its ledger id
  const all = [...new Map(out.flat().map((f) => [lib.ledger.id(f.title), f])).values()]
  const open = all.filter((f) => !isClosed(f))
  if (open.length < all.length) log('ledger: dropped ' + (all.length - open.length) + ' findings marked fixed, rejected or wontfix')
  return open
}
const roundA = await validate('A', [
  { id: 'qa', text: 'QA: every link, control and section works as research/SPEC.md says. Find the project\'s own check when none ran.', extra: checks.length ? lib.fence('checks', checks.map((c) => (c.ok ? 'ok ' : 'FAILED ') + c.command + (c.tail ? '\n' + c.tail : '')).join('\n')) : '' },
  { id: 'a11y', text: 'accessibility: WCAG AA contrast, keyboard, focus, reduced motion and the Motion Off toggle, the axe results in report.json', agentType: 'reviewer' },
  { id: 'design', text: 'design: the site against research/STYLE.md and the web-studio ban list', agentType: 'reviewer' },
  { id: 'security', text: 'security: CSP, link targets with rel="noopener", no secrets in the bundle, photo EXIF stripped', agentType: 'reviewer' },
])
const cleanA = !roundA.some((f) => f.severity === 'high' || f.severity === 'medium') && checks.every((c) => c.ok)
let roundB = null
if (cleanA) {
  roundB = await validate('B', [
    { id: 'break-it', text: 'break-it: try to break every interaction: fast scrolling, resizing, back and forward, keyboard only, slow network' },
    { id: 'persona', text: 'a persona from the brief\'s audience (for example a hiring manager) visiting for the first time: what they look for and what stops them', agentType: 'reviewer' },
    { id: 'owner-proxy', text: 'owner proxy: does the site say what the owner\'s brief says, in the owner\'s intent but not their casual words', agentType: 'reviewer' },
  ])
} else log('round B skipped: round A found ' + roundA.filter((f) => f.severity !== 'low').length + ' high or medium findings' + (checks.every((c) => c.ok) ? '' : ' and a check failed'))

const found = [...roundA, ...(roundB || [])]
await lib.ledger.write(root, found.map((f) => ({ id: lib.ledger.id(f.title), finding: f.title, severity: f.severity, verdict: 'open', round: ledgerRound, evidence: f.evidence })))

return {
  passed: lookPassed && cleanA && !!roundB && !roundB.some((f) => f.severity === 'high'),
  read: readText,
  spec: root + '/research/STYLE.md and SPEC.md',
  picked: { option: picked.option, angle: picked.angle, page: picked.page, ...(picked.branch ? { branch: picked.branch } : {}) },
  url,
  ...(serve && serve.stop ? { stopServer: serve.stop } : {}),
  look: { passed: lookPassed, rounds: rounds.map((r) => ({ round: r.round, avg: r.avg, min: r.min, passed: r.passed, blockers: r.blockers, weakest: r.weakest, capture: r.capture })), ...(stopped ? { stopped } : {}) },
  checks,
  validation: { roundA, cleanA, roundB },
  ledgerRound,
}
