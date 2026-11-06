export const meta = {
  name: 'security-hunt',
  description: 'A Security mode hunt on one target: scope preflight, hunt memory read first, recon, three hunter routes until two rounds find nothing new, citation and dedupe filters, one refuter call per lead, an approval grant before any live host, the lane oracle at runtime, the 7-Question Gate, then the ledger and catalogue written last and draft reports. A lead is confirmed only when the runtime oracle passed, checked in this script',
  whenToUse: 'In a hunt folder with targets/<target>/scope.yaml. args: { lane: "source" | "web" | "variant", target: a target name, url?: the live app (web lane, or proof on web), hosts?: live hosts, scopeFile?: default targets/<target>/scope.yaml, device?: where the validator runs, fix?: the fix commit (variant), advisory?: its text (variant), proofLane?: "source" | "web" (variant), maxLeads?: 10, round? }',
  runtime: 'conclave',
  phases: [{ title: 'Preflight' }, { title: 'Load' }, { title: 'Recon' }, { title: 'Hunt' }, { title: 'Filter' }, { title: 'Refute' }, { title: 'Approve' }, { title: 'Validate' }, { title: 'Gate' }, { title: 'Record' }, { title: 'Report' }],
}

// docs/design/SECURITY-MODE.md 3.1 and 3.2. Roles go by agentType (sec-*), never a model: routing and the pin pick the model.
const A = args && typeof args === 'object' ? args : {}
const LANE = ['source', 'web', 'variant'].includes(A.lane) ? A.lane : 'source'
const T = String(A.target || '').trim()
const MAX_LEADS = Number.isInteger(A.maxLeads) && A.maxLeads > 0 ? Math.min(A.maxLeads, 10) : 10
const SCOPE_FILE = typeof A.scopeFile === 'string' && A.scopeFile.trim() ? A.scopeFile.trim() : 'targets/' + T + '/scope.yaml'
const LIVE = (Array.isArray(A.hosts) && A.hosts.length ? A.hosts : A.url ? [A.url] : []).map(String)
const HUNT = 'findings/' + T + '-hunt'
const RESULT = HUNT + '/RESULT.txt'
const ON = A.device ? { device: String(A.device) } : {}
const LANE_NAME = { source: 'white-box source', web: 'web black-box (Caido)', variant: 'variant' }

const stop = (step, reason) => {
  log('Stopped at ' + step + ': ' + reason)
  return { stopped: step, reason, lane: LANE, target: T, leads: [] }
}

// Bug-class oracles (3.2): the observable proof and the negative controls the validator must run.
const ORACLES = {
  'read-authz': { proof: 'The low role or tenant A gets tenant B\u2019s seeded canary.', controls: ['A on its own object succeeds', 'a forbidden sibling endpoint (for example /members) returns 403'] },
  'write-authz': { proof: 'A\u2019s request changes B\u2019s object, and B\u2019s own session then reads the new value.', controls: ['the same write on A\u2019s object succeeds', 'B\u2019s object is unchanged when A sends no request'] },
  'auth-bypass': { proof: 'A protected resource returns its content with no or wrong credentials.', controls: ['the same request with valid credentials of a user without access is denied'] },
  xss: { proof: 'A unique marker runs in a second Playwright browser session (a window flag or a call to a lab listener).', controls: ['the same input with an inert payload renders as text and the marker never fires'] },
  ssrf: { proof: 'The target fetches a unique path on a listener the owner controls (lab host or a callback host in scope.yaml).', controls: ['a request with a harmless URL makes no listener hit with that path'] },
}
const CLASSES = Object.keys(ORACLES).concat('other')
const GATE = ['The impact is real now, on the shipped version', 'Someone can reproduce it in under 5 minutes', 'It is in scope for the program', 'Confidence is above 90%', 'It is not a known or fixed issue (CVE, advisory, latest release)', 'The program pays for this class', 'The impact fits in one sentence']

// ----- 0. Preflight: the scope file, parsed by the scope guard's own parser -----
phase('Preflight')
if (!/^[a-z0-9][a-z0-9_-]*$/i.test(T)) return stop('preflight', 'args.target must be a target name such as acme (letters, digits, - and _)')
const sc = await lib.scope(SCOPE_FILE, { hosts: LIVE })
if (!sc.ok) return stop('preflight', 'scope file: ' + sc.error)
if (sc.expired) return stop('preflight', sc.file + ' expired on ' + sc.scope.expires)
const notIn = LIVE.filter((h) => sc.hosts[h] !== 'in')
if (notIn.length) return stop('preflight', 'not in in_scope of ' + sc.file + ': ' + notIn.join(', '))
if (LANE === 'web' && !LIVE.length) return stop('preflight', 'the web lane needs args.url or args.hosts')
if (LANE === 'variant' && A.proofLane === 'web' && !LIVE.length) return stop('preflight', 'a variant proved on the web lane needs args.url or args.hosts')
if (LANE === 'variant' && !A.fix) return stop('preflight', 'the variant lane needs args.fix (the fix commit)')
const scope = sc.scope
log('Scope ' + sc.file + ': program ' + scope.program + ', ' + scope.inScope.length + ' in-scope entries, lab ' + (scope.lab.join(', ') || 'none') + (scope.expires ? ', expires ' + scope.expires : ''))

// ----- 1. Load (read first): the hub ledger, the playbook, the catalogue, PARKED.md, the ledger.jsonl tail -----
phase('Load')
const ledger = await lib.ledger.read('.')
const memory = await agent(
  [
    'Load the hunt memory for target ' + T + ' before anyone hunts. Read playbook/hunting-logic.md, targets/' + T + '/catalogue.md, PARKED.md and the last 200 lines of targets/' + T + '/ledger.jsonl (run tail -n 200). A missing file is fine; say which ones were missing.',
    'Return known: one line per bug already found, reported or fixed on this target; parked: one line per parked lead with its reason; notes: the playbook rules that apply to this lane (' + LANE_NAME[LANE] + ').',
  ].join('\n\n'),
  { label: 'load', agentType: 'sec-recon', schema: { type: 'object', properties: { known: { type: 'array', items: { type: 'string' } }, parked: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' }, missing: { type: 'array', items: { type: 'string' } } }, required: ['known', 'parked'] }, conclave: ON },
)
const known = memory ? memory.known : []
const parkedBefore = memory ? memory.parked : []
const memoryFence = [lib.fence('hunt-memory', { known, parked: parkedBefore, notes: (memory && memory.notes) || '' }), lib.ledger.fence(ledger)].filter(Boolean).join('\n\n')

// ----- 2. Recon -----
phase('Recon')
const RECON = {
  source: 'Mechanical gate inventory and carrier sweep (the rg commands in the cve-violation-hunt skill); write the generalised gate rule before narrowing.',
  web: 'Caido history and sitemap only (read tools); JS recon and parameter mining from what is already captured. Send no new request to a live host.',
  variant: 'Read the advisory and the fix, then map where the same guard idiom applies in the target.',
}
const brief = await agent(
  [
    'Map the attack surface of target ' + T + ' for a ' + LANE_NAME[LANE] + ' hunt and write targets/' + T + '/brief.md: facts, open questions, checks not to repeat.',
    RECON[LANE],
    'Return the guard idiom (the permission-check helper and how routes call it), the role or tenant table if one exists, and the data carriers (fields that move data across a boundary).',
    memoryFence,
  ].join('\n\n'),
  { label: 'recon', agentType: 'sec-recon', schema: { type: 'object', properties: { guardIdiom: { type: 'string' }, roles: { type: 'array', items: { type: 'string' } }, carriers: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } }, required: ['guardIdiom', 'carriers', 'summary'] }, conclave: ON },
)
if (!brief) return stop('recon', 'the recon brief came back empty')
if (!brief.guardIdiom || !brief.carriers.length) log('Recon brief has no ' + (!brief.guardIdiom ? 'guard idiom' : 'carriers') + '; hunting on what it has')

let rule = null
if (LANE === 'variant') {
  rule = await agent(
    [
      'Write a violation rule for the fix ' + String(A.fix) + ' (the cve-violation-hunt and tool-semgrep-fix-rule skills). The rule must fire on ' + String(A.fix) + '^ and stay silent on ' + String(A.fix) + '. Run it on both and report the match counts and the exact commands.',
      A.advisory ? lib.fence('advisory', String(A.advisory)) : '',
    ].filter(Boolean).join('\n\n'),
    { label: 'variant rule', agentType: 'sec-hunter', schema: { type: 'object', properties: { rule: { type: 'string' }, onParent: { type: 'integer', minimum: 0 }, onFix: { type: 'integer', minimum: 0 }, commands: { type: 'array', items: { type: 'string' } } }, required: ['rule', 'onParent', 'onFix', 'commands'] }, conclave: ON },
  )
  // checked here, not by the agent: a rule that does not tell the fix from its parent finds nothing real
  if (!rule || !(rule.onParent > 0) || rule.onFix !== 0) return stop('recon', 'the violation rule does not fire on the fix parent and stay silent on the fix' + (rule ? ' (' + rule.onParent + ' on parent, ' + rule.onFix + ' on fix)' : ''))
  log('Variant rule ' + rule.rule + ': ' + rule.onParent + ' matches on ' + A.fix + '^, 0 on ' + A.fix)
}

// ----- 3. Hunt: three routes in parallel, until two rounds find nothing new -----
phase('Hunt')
const LEAD = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'Path from the hunt folder (for example targets/acme/src/api/invoices.ts); for a web lead, the route (GET /api/v2/invoices/:id)' },
    line: { type: 'integer', minimum: 1 },
    quote: { type: 'string', description: 'The cited line, copied exactly' },
    title: { type: 'string' },
    class: { type: 'string', enum: CLASSES },
    invariant: { type: 'string', description: 'The rule the code breaks' },
    proofPlan: { type: 'string', description: 'How the validator proves it at runtime, with the observable and the negative control' },
    observable: { type: 'string', description: 'Class other only: the observable proof, written before the run' },
    negativeControl: { type: 'string', description: 'Class other only: the negative control, written before the run' },
    needsLive: { type: 'boolean', description: 'True when only the live host can prove it (the lab stack cannot)' },
    priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
  },
  required: ['file', 'line', 'quote', 'title', 'class', 'invariant', 'proofPlan', 'priority'],
}
const LEADS = { type: 'object', properties: { leads: { type: 'array', items: LEAD } }, required: ['leads'] }
const ROUTES = ['continue the leader: take the strongest lead so far, or the most promising route from the brief, and push it to a proof plan', 'isolate the blocker: find what stops the leader (a guard, a later filter, a role check) and test whether it holds everywhere', 'try an alternative: a different route, carrier or bug class from the brief']
const keyOf = (l) => (l.file || '') + ':' + (l.line || '') + ':' + (l.class || '')
const found = await lib.loopUntilDry(async (round, sofar) => {
  if (sofar.length >= MAX_LEADS) return []
  const got = await parallel(ROUTES.map((route, i) => () =>
    agent(
      [
        'Hunt for leads on target ' + T + ' (' + LANE_NAME[LANE] + '), round ' + round + ', route ' + (i + 1) + ': ' + route + '.',
        'Each lead needs file:line with the exact quote, the invariant it breaks, its class, and a proof plan the validator can run. Read code, Caido history and the lab stack only; send nothing to a live host.' + (LANE === 'variant' ? ' You never see the fixed build: hunt the target with the violation rule ' + rule.rule + '.' : ''),
        lib.fence('recon-brief', brief),
        sofar.length ? lib.fence('leads-so-far', sofar.map((l) => keyOf(l) + ' ' + l.title).join('\n')) : '',
        memoryFence,
      ].filter(Boolean).join('\n\n'),
      { label: 'hunt r' + round + ' route ' + (i + 1), agentType: 'sec-hunter', schema: LEADS, conclave: ON },
    ),
  ))
  return got.filter(Boolean).flatMap((g) => g.leads || [])
}, { k: 2, maxRounds: 4, key: keyOf })
if (found.length > MAX_LEADS) log('Hunt found ' + found.length + ' leads; kept the first ' + MAX_LEADS)
const hunted = found.slice(0, MAX_LEADS)

// ----- 4. Filter: citations at the shipped version, dismissed before, dedupe against the memory and the ledger -----
phase('Filter')
let kept = lib.dedupe(hunted)
if (LANE !== 'web') kept = (await lib.checkCitations(kept)).kept
kept = await lib.dropDismissed(kept)
const closed = new Set(ledger.filter((e) => e.verdict === 'fixed' || e.verdict === 'rejected' || e.verdict === 'wontfix').map((e) => e.id))
const knownIds = new Set(known.concat(parkedBefore).map((k) => lib.ledger.id(k)))
const before = kept.length
kept = kept.filter((l) => !closed.has(lib.ledger.id(l.title)) && !knownIds.has(lib.ledger.id(l.title)))
if (before > kept.length) log('Dropped ' + (before - kept.length) + ' leads already in the ledger, the catalogue or PARKED.md')
const leads = kept.map((l, i) => Object.assign({}, l, { n: i + 1, id: lib.ledger.id(l.title), status: 'open' }))

// ----- 5. Refute: one sec-refuter call per lead; its assumptions feed the proof plan, its votes never confirm -----
phase('Refute')
const REFUTE = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'unverifiable'] },
    lenses: { type: 'array', items: { type: 'object', properties: { lens: { type: 'string' }, vote: { type: 'string', enum: ['holds', 'refuted'] }, reason: { type: 'string' } }, required: ['lens', 'vote', 'reason'] } },
    assumptions: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, tested: { type: 'boolean' }, how: { type: 'string', description: 'For tested: the command you ran and its output. For untested: what would test it.' } }, required: ['text', 'tested', 'how'] } },
    note: { type: 'string' },
  },
  required: ['verdict', 'lenses', 'assumptions', 'note'],
}
await pipeline(leads, async (l) => {
  const r = await agent(
    [
      'Refute this lead in one call, through three lenses: Reachability (can the lowest role reach it), Boundary rule (is this data or action meant for that role, per the UI and the docs), Downstream check (does a later layer stop it). Default to refuted.',
      'List every assumption the lead relies on, each marked tested or untested. tested is true only when you ran a command and quote its output in how. Read-only checks on the lab stack are fine; nothing on a live host.',
      lib.fence('lead', { file: l.file, line: l.line, quote: l.quote, title: l.title, class: l.class, invariant: l.invariant, proofPlan: l.proofPlan }),
    ].join('\n\n'),
    { label: 'refute lead ' + l.n, agentType: 'sec-refuter', schema: REFUTE, conclave: Object.assign({ withMeta: true }, ON) },
  )
  const v = r && r.value
  l.refuter = { model: (r && r.model) || '', votes: v ? v.lenses : [], verdict: v ? v.verdict : 'none', note: v ? v.note : 'no answer' }
  // a tested claim without the command and its output counts as untested
  l.assumptions = (v ? v.assumptions : []).map((a) => ({ text: a.text, tested: a.tested === true && String(a.how || '').trim().length > 0, how: a.how || '' }))
  if (v && (v.verdict === 'refuted' || v.lenses.some((x) => x.vote === 'refuted'))) {
    l.status = 'refuted'
    l.reason = 'refuter: ' + v.note
  }
  return l
})
const live = leads.filter((l) => l.status === 'open')
log('Refuter: ' + live.length + ' of ' + leads.length + ' leads hold; votes never confirm, only step 7 does')

// ----- 6 and 7. Approve and validate, lead by lead, so one grant covers later leads on this target -----
const laneChanges = []
let grant = null
let grantLeft = 0
let grantAsks = 0
let grantDenied = false

const oracleCheck = async (l, v, proofLane, marker) => {
  if (!v) return { state: 'partial', why: 'the validator returned nothing' }
  const row = ORACLES[l.class]
  if (!row && !(l.class === 'other' && l.observable && l.negativeControl)) return { state: 'partial', why: 'no oracle for class ' + l.class + ' and no observable written before the run' }
  const runs = Array.isArray(v.runs) ? v.runs : []
  const controls = Array.isArray(v.controls) ? v.controls : []
  const need = row ? row.controls.length : 1
  if (v.reproduced === false && runs.length && runs.every((r) => !r.pass)) return { state: 'refuted', why: 'not reproduced in ' + runs.length + ' runs' }
  if (v.reproduced !== true) return { state: 'partial', why: 'the validator did not report it reproduced' }
  if (runs.length < 3 || !runs.every((r) => r.pass === true)) return { state: 'partial', why: runs.filter((r) => r.pass === true).length + ' of ' + Math.max(3, runs.length) + ' runs passed' }
  if (controls.length < need || !controls.every((c) => c.pass === true)) return { state: 'partial', why: 'negative control ' + controls.filter((c) => c.pass === true).length + ' of ' + need + ' held' }
  if (proofLane === 'web' && !(typeof v.pairs === 'string' && v.pairs.trim())) return { state: 'partial', why: 'the request pairs were not exported' }
  // the evidence file is read here, not taken from the agent: it must exist and hold this lead's marker
  const file = typeof v.result === 'string' && v.result.trim() ? v.result.trim().replace(/^\.\//, '') : RESULT
  // only a file in this hunt's findings folder: a transcript or database elsewhere holds the marker from the prompt
  if (!file.startsWith(HUNT + '/') || file.split('/').includes('..')) return { state: 'partial', why: file + ' is not in ' + HUNT }
  const cat = await lib.exec('cat ' + lib.shq(file))
  if (cat.exitCode !== 0) return { state: 'partial', why: file + ' could not be read' }
  if (!cat.stdout.includes(marker)) return { state: 'partial', why: file + ' does not hold the marker ' + marker }
  return { state: 'confirmed', why: '3 of 3 runs and every negative control passed; evidence in ' + file }
}

// a fresh nonce per run in every marker: a RESULT.txt left by an earlier run (written even when the runs failed) never matches
const nonce = live.length ? (await lib.exec('head -c 6 /dev/urandom | od -An -tx1')).stdout.replace(/\s/g, '') : ''
const fresh = /^[0-9a-f]{12}$/.test(nonce)
if (live.length && !fresh) log('No run nonce from the device; no lead can be confirmed this run')

for (const l of live) {
  phase('Approve')
  let proofLane = LANE === 'variant' ? (A.proofLane === 'web' ? 'web' : 'source') : LANE
  if (proofLane === 'source' && l.needsLive === true) {
    if (!LIVE.length) {
      l.status = 'partial'
      l.reason = 'only the live host can prove it; run again with args.url'
      continue
    }
    // the one lane change the workflow makes by itself: a source lead to its web proof (design 1.2)
    laneChanges.push({ lead: l.n, from: 'source', to: 'web', why: 'only the live host can prove it' })
    log('Lane: source -> web for the proof of lead ' + l.n + ' (' + l.title + ')')
    await lib.notice('lane', 'Lane: ' + LANE_NAME.source + ', proof of lead ' + l.n + ' on ' + LANE_NAME.web + '.', { from: 'source', to: 'web', lead: l.n })
    proofLane = 'web'
  }
  if (proofLane === 'web') {
    if (grantDenied) {
      l.status = 'partial'
      l.reason = 'no approval grant for the live host'
      continue
    }
    if (!grant || grantLeft <= 0) {
      grantAsks++
      const untested = l.assumptions.filter((a) => !a.tested)
      const g = await lib.approve(
        'Allow live requests to ' + LIVE.join(', ') + '? Lead ' + l.n + ' (' + l.title + ') needs the live host' + (untested.length ? '; untested: ' + untested.map((a) => a.text).join('; ') : '') + '. One grant covers every later lead on ' + T + ' until it expires or its budget runs out.',
        { grant: { hosts: LIVE, accounts: scope.accounts, requests: scope.requestBudget, rateRps: scope.rateLimitRps, hours: 24, scopeFile: SCOPE_FILE, scopeLine: 'in_scope ' + JSON.stringify(scope.inScope) + ', ' + SCOPE_FILE } },
      )
      if (!g) {
        grantDenied = true
        l.status = 'partial'
        l.reason = 'no approval grant for the live host'
        log('Lead ' + l.n + ' parked as partial: no approval grant')
        continue
      }
      grant = g
      grantLeft = g.requestBudget
    } else {
      log('Grant ' + grant.id + ' covers lead ' + l.n + ' (' + grantLeft + ' requests left)')
    }
  }

  phase('Validate')
  const marker = 'CANARY-' + lib.ledger.id(T + ' ' + l.id + ' ' + l.n).slice(0, 10) + nonce
  const row = ORACLES[l.class]
  const untested = l.assumptions.filter((a) => !a.tested)
  const r = await agent(
    [
      'Run the lane oracle for lead ' + l.n + ' on target ' + T + ' and report what happened. Default verdict: not reproduced.',
      proofLane === 'web'
        ? 'Web black-box: in-scope hosts ' + LIVE.join(', ') + ' only, with the owner\u2019s test accounts (' + (scope.accounts.join(', ') || 'none listed') + '), at most ' + grantLeft + ' requests at ' + grant.rateRps + ' per second. Replay through Caido with two tenants and export the request pairs; diff the responses.'
        : 'White-box source: the lab stack on ' + (scope.lab.join(', ') || 'the sec-lab-' + T + ' network') + ' at the shipped version (docker exec checks the compiled code), seeded with two tenants or roles. No live host.',
      row ? 'Oracle for ' + l.class + ': ' + row.proof + ' Negative controls: ' + row.controls.join('; ') + '.' : 'Oracle (written before the run): ' + (l.observable || 'none') + '. Negative control: ' + (l.negativeControl || 'none') + '.',
      'Seed or use the marker ' + marker + ' as the canary. Run the proof 3 times (fresh session each time), then each negative control. Write every command, request and response pair (auth headers redacted) and exit code to ' + RESULT + ', with the marker in it.',
      untested.length ? 'Also test these assumptions in the same runs: ' + untested.map((a) => a.text).join('; ') : '',
      'Never touch: ' + (scope.no.join(', ') || 'nothing listed') + '. Out of scope: ' + (scope.outOfScope.join(', ') || 'nothing listed') + '.',
      lib.fence('lead', { file: l.file, line: l.line, quote: l.quote, title: l.title, class: l.class, proofPlan: l.proofPlan }),
    ].filter(Boolean).join('\n\n'),
    {
      label: 'validate lead ' + l.n,
      phase: 'Validate',
      agentType: 'sec-validator',
      schema: {
        type: 'object',
        properties: {
          reproduced: { type: 'boolean' },
          runs: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, detail: { type: 'string' }, pass: { type: 'boolean' } }, required: ['label', 'detail', 'pass'] } },
          controls: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, detail: { type: 'string' }, pass: { type: 'boolean' } }, required: ['label', 'detail', 'pass'] } },
          evidence: { type: 'string', description: 'The key request and response, auth redacted' },
          result: { type: 'string', description: 'Path of RESULT.txt' },
          pairs: { type: 'string', description: 'Web lane: path of the exported request pairs' },
          requests: { type: 'integer', minimum: 0, description: 'Requests sent to live hosts' },
          on: { type: 'string', description: 'Where it ran: the lab network or the live host' },
        },
        required: ['reproduced', 'runs', 'controls', 'evidence', 'result'],
      },
      conclave: Object.assign({ withMeta: true }, ON),
    },
  )
  const v = r && r.value
  if (proofLane === 'web' && v) grantLeft -= Math.max(1, Number(v.requests) || 0)
  const verdict = fresh ? await oracleCheck(l, v, proofLane, marker) : { state: 'partial', why: 'no run nonce, so the evidence cannot be told from an earlier run' }
  // the only place a lead becomes confirmed: step 7's runtime oracle passed
  l.status = verdict.state
  l.reason = verdict.why
  l.proofLane = proofLane
  l.oracle = v ? { model: (r && r.model) || '', on: v.on || (proofLane === 'web' ? LIVE.join(', ') : scope.lab.join(', ')), runs: (v.runs || []).concat(v.controls || []), evidence: v.evidence || '', result: v.result || RESULT } : null
}

// ----- 8. Gate: the 7 questions for each confirmed lead; any no parks it, it is never deleted -----
phase('Gate')
for (const l of leads.filter((x) => x.status === 'confirmed')) {
  const g = await agent(
    ['Answer the 7-Question Gate for this confirmed finding. One answer per question, yes or no, with the reason. Be strict: a guess is a no.', GATE.map((q, i) => i + 1 + '. ' + q).join('\n'), lib.fence('finding', { title: l.title, class: l.class, file: l.file, line: l.line, evidence: l.oracle && l.oracle.evidence, program: scope.program, venue: scope.venue || '' })].join('\n\n'),
    { label: 'gate lead ' + l.n, agentType: 'sec-refuter', schema: { type: 'object', properties: { answers: { type: 'array', items: { type: 'object', properties: { yes: { type: 'boolean' }, why: { type: 'string' } }, required: ['yes', 'why'] } } }, required: ['answers'] }, conclave: ON },
  )
  const answers = (g && g.answers) || []
  const no = GATE.map((q, i) => (answers[i] && answers[i].yes === true ? null : q + ': ' + ((answers[i] && answers[i].why) || 'no answer'))).filter(Boolean)
  if (no.length) {
    l.parked = 'gate: ' + no.join('; ')
    log('Lead ' + l.n + ' parked by the gate: ' + no[0])
  }
}

// finding cards in the session: evidence, the refuter's votes and the untested assumptions
for (const l of leads) {
  const untested = l.assumptions.filter((a) => !a.tested).length
  await lib.notice('finding', 'Finding ' + l.n + ' ' + l.status + ': ' + l.title, {
    n: l.n,
    title: l.title,
    state: l.status === 'open' ? 'partial' : l.status,
    where: l.file + ':' + l.line,
    summary: l.invariant,
    ...(l.oracle ? { oracle: l.oracle } : {}),
    refuter: { model: l.refuter.model, votes: l.refuter.votes, assumptions: l.assumptions },
    next: l.parked || l.reason || (untested ? untested + ' untested assumptions go into the proof plan' : 'not run'),
  })
}

// ----- 9. Record (write last): findings, the hub ledger, ledger.jsonl, then one approval for the catalogue -----
phase('Record')
const round = Number.isInteger(A.round) ? A.round : ledger.reduce((m, e) => Math.max(m, e.round || 0), 0) + 1
const VERDICT = { confirmed: 'open', partial: 'open', open: 'open', refuted: 'rejected' }
const SEV = { P0: 'high', P1: 'high', P2: 'medium', P3: 'low' }
const findings = leads.map((l) => ({ id: l.id, file: l.file, line: l.line, quote: l.quote, title: l.title, class: l.class, priority: l.priority, scenario: l.invariant, status: l.status, reason: l.reason || '', parked: l.parked || '', proven: l.status === 'confirmed', votes: l.refuter.votes.map((x) => x.vote), untested: l.assumptions.filter((a) => !a.tested).map((a) => a.text), proofLane: l.proofLane || LANE }))
await lib.recordFindings(findings)
await lib.ledger.write('.', leads.map((l) => ({ id: l.id, finding: l.title + ' (' + l.file + ':' + l.line + ')', severity: SEV[l.priority] || 'medium', verdict: VERDICT[l.status] || 'open', round, ...(l.status === 'confirmed' ? { evidence: (l.oracle && l.oracle.result) || RESULT } : {}) })))
const jsonl = leads.map((l) => JSON.stringify({ target: T, lead: l.id, title: l.title, class: l.class, status: l.status, yields: l.class, needs: l.status === 'confirmed' ? '' : l.reason || '', result: l.status === 'confirmed' ? (l.oracle && l.oracle.result) || RESULT : '', parked: l.parked || '', round }))
const written = await agent(
  [
    'Write back the hunt ledger for target ' + T + '. Append these lines, exactly as given, to targets/' + T + '/ledger.jsonl (create it if missing), and add every partial or parked lead to PARKED.md with its reason. Then propose the catalogue changes this run supports (new classes, routes proved safe, guard idioms) as a unified diff of targets/' + T + '/catalogue.md. Do not edit catalogue.md.',
    lib.fence('ledger-lines', jsonl.join('\n') || '(no leads this run)'),
  ].join('\n\n'),
  { label: 'record', agentType: 'sec-recon', schema: { type: 'object', properties: { appended: { type: 'integer', minimum: 0 }, catalogueDiff: { type: 'string' } }, required: ['appended', 'catalogueDiff'] }, conclave: ON },
)
let catalogue = 'none proposed'
if (written && written.catalogueDiff.trim()) {
  // one question for the whole run; an unattended run keeps the catalogue as it is
  const pick = await lib.ask('Apply these catalogue changes to targets/' + T + '/catalogue.md?\n\n' + written.catalogueDiff, ['Not now', 'Apply'])
  if (pick === 'Apply') {
    await agent(['Apply the approved catalogue changes to targets/' + T + '/catalogue.md exactly as in this diff.', lib.fence('diff', written.catalogueDiff)].join('\n\n'), { label: 'catalogue', agentType: 'sec-recon', conclave: ON })
    catalogue = 'applied'
  } else catalogue = 'proposed, not applied'
}

// ----- 10. Report: drafts for confirmed findings the gate passed; the owner submits -----
phase('Report')
const reportable = leads.filter((l) => l.status === 'confirmed' && !l.parked)
const drafts = await pipeline(reportable, (l) =>
  agent(
    ['Draft REPORT.md for this confirmed finding at ' + HUNT + '/REPORT.md (one section per finding when several). Draft only; never submit. Read ' + ((l.oracle && l.oracle.result) || RESULT) + ' first and refuse without it.', lib.fence('finding', { n: l.n, title: l.title, file: l.file, line: l.line, class: l.class, evidence: l.oracle && l.oracle.evidence, program: scope.program, venue: scope.venue || '' })].join('\n\n'),
    { label: 'report lead ' + l.n, agentType: 'sec-reporter', conclave: ON },
  ),
)

const count = (s) => leads.filter((l) => l.status === s).length
return {
  lane: LANE,
  target: T,
  leads: leads.map((l) => ({ n: l.n, title: l.title, where: l.file + ':' + l.line, class: l.class, status: l.status, reason: l.reason || '', parked: l.parked || '', proofLane: l.proofLane || LANE })),
  findings,
  laneChanges,
  grants: { asked: grantAsks, granted: grant ? grant.id : null, denied: grantDenied },
  catalogue,
  drafts: drafts.filter(Boolean).length,
  report: leads.length
    ? count('confirmed') + ' confirmed, ' + count('partial') + ' partial, ' + count('refuted') + ' refuted of ' + leads.length + ' leads. Confirmed means the runtime oracle passed 3 of 3 with its negative controls; refuter votes never confirm.'
    : 'No lead survived the filters.',
}
