export const meta = {
  name: 'security-audit',
  description: 'Audit a codebase for security bugs: every top-level folder scanned or skipped with a reason, a threat model per component, research per component and lens, a sweep of what was missed, and a REACHABILITY, IMPACT and DEFENSES panel',
  whenToUse: 'For a security review of a repository, or of the homelab with target "homelab". args: { target?: "repo" | "homelab", devices?: device ids for homelab (default pve and madx), maxComponents?: 8 }',
  runtime: 'conclave',
  phases: [{ title: 'Inventory' }, { title: 'Threat model' }, { title: 'Research' }, { title: 'Sweep' }, { title: 'Panel' }, { title: 'Report' }],
}

const A = args && typeof args === 'object' ? args : {}
const homelab = A.target === 'homelab'
const MAX_COMPONENTS = Number.isInteger(A.maxComponents) ? A.maxComponents : 8

// shipped hard exclusions, after claude-code-security-review's rules; a project file can add its own
const DEFAULT_EXCLUSIONS = [
  'Denial of service by resource exhaustion without an amplification',
  'Secrets that sit in .env.example, test fixtures or documentation as placeholders',
  'Rate limiting that is missing, unless the endpoint spends money or sends mail',
  'Memory safety issues in memory-safe languages',
  'Findings in test files only',
  'Log spoofing and missing audit logs',
  'Regex DoS on input the owner controls',
  'Theoretical timing attacks without a measurable signal',
  'Outdated dependencies with no reachable vulnerable call',
]

// the same classes as checks in code, run before the panel: a finding that matches one never costs votes
// (claude-code-security-review filters with rules like these before its model filter)
const MEMORY_SAFE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|kt|java|rb|php|cs|swift)$/i
const HARD_RULES = [
  { why: 'in test files only', test: (f) => /(^|\/)(tests?|__tests__|spec|fixtures?|__mocks__)\//i.test(f.file || '') || /\.(test|spec)\.[a-z]+$/i.test(f.file || '') },
  { why: 'in documentation or an example file', test: (f) => /\.(md|mdx|rst|txt|adoc)$/i.test(f.file || '') || /(^|\/)\.env\.(example|sample|template)$/i.test(f.file || '') || /(^|\/)docs?\//i.test(f.file || '') },
  { why: 'denial of service by resource exhaustion', test: (f) => /\b(denial of service|\bdos\b|resource exhaustion|exhaust(s|ion of)? (memory|cpu|disk))/i.test(f.title || '') && !/amplif/i.test((f.title || '') + ' ' + (f.scenario || '')) },
  { why: 'missing rate limiting', test: (f) => /\brate.?limit/i.test(f.title || '') },
  { why: 'memory safety in a memory-safe language', test: (f) => /\b(buffer overflow|use.after.free|double free|out.of.bounds (write|read))\b/i.test(f.title || '') && MEMORY_SAFE.test(f.file || '') },
  { why: 'log spoofing or a missing audit log', test: (f) => /\blog (spoofing|injection|forging)\b|missing audit log/i.test(f.title || '') },
  { why: 'regular expression denial of service', test: (f) => /\bredos\b|catastrophic backtracking|regex(p)? (denial|dos)/i.test(f.title || '') },
  { why: 'a theoretical timing attack', test: (f) => /\btiming (attack|side.channel)\b/i.test(f.title || '') },
  { why: 'an outdated dependency', test: (f) => /\b(outdated|old|vulnerable) (dependency|dependencies|package|version)\b/i.test(f.title || '') },
]
const hardExcluded = (f) => HARD_RULES.find((r) => r.test(f))

phase('Inventory')
let exclusions = DEFAULT_EXCLUSIONS
if (!homelab) {
  const custom = await lib.exec('cat .conclave/security-exclusions.md 2>/dev/null || true')
  const extra = custom.stdout.split('\n').map((l) => l.replace(/^[-*]\s*/, '').trim()).filter((l) => l && !l.startsWith('#'))
  if (extra.length) {
    exclusions = DEFAULT_EXCLUSIONS.concat(extra)
    log('Using ' + extra.length + ' project exclusions from .conclave/security-exclusions.md')
  }
}

let components
if (homelab) {
  const devices = Array.isArray(A.devices) && A.devices.length ? A.devices : ['pve', 'madx']
  components = devices.map((d) => ({ name: d, path: '/', device: d, why: 'homelab host' }))
  log('Homelab audit on ' + devices.join(', ') + ', read-only')
} else {
  // a plain file list (read-only, so it never asks); the folders are counted here, not with awk
  const dirs = [...new Set((await lib.exec('git ls-files')).stdout.split('\n').filter((f) => f.includes('/')).map((f) => f.split('/')[0]))].sort()
  const inv = await agent(
    [
      'Partition this repository into security components for an audit. Every top-level folder below must appear exactly once, either in a component or in skipped with a reason (vendored code, generated files, docs only, test fixtures).',
      lib.fence('top-level-folders', dirs.join('\n')),
    ].join('\n\n'),
    {
      label: 'inventory',
      phase: 'Inventory',
      agentType: 'explore',
      schema: {
        type: 'object',
        properties: {
          components: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } }, why: { type: 'string' } }, required: ['name', 'paths'] } },
          skipped: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, reason: { type: 'string' } }, required: ['path', 'reason'] } },
        },
        required: ['components', 'skipped'],
      },
    },
  )
  if (!inv) throw new Error('the inventory came back empty')
  // checked in code: every folder is scanned or skipped with a reason
  const covered = new Set([...inv.components.flatMap((c) => c.paths.map((p) => p.split('/')[0])), ...inv.skipped.map((s) => s.path.split('/')[0])])
  const missing = dirs.filter((d) => !covered.has(d))
  if (missing.length) {
    log('The inventory left out ' + (missing.length === 1 ? '1 folder; it is added as its own component: ' : missing.length + ' folders; they are added as their own components: ') + missing.join(', '))
    for (const m of missing) inv.components.push({ name: m, paths: [m], why: 'left out by the inventory' })
  }
  components = inv.components.map((c) => ({ name: c.name, path: c.paths.join(', '), why: c.why }))
  if (components.length > MAX_COMPONENTS) {
    log('Auditing ' + MAX_COMPONENTS + ' of ' + components.length + ' components; not audited: ' + components.slice(MAX_COMPONENTS).map((c) => c.name).join(', '))
    components = components.slice(0, MAX_COMPONENTS)
  }
  for (const s of inv.skipped) log('Skipped ' + s.path + ': ' + s.reason)
}

const where = (c) => (c.device ? { conclave: { device: c.device, cwd: '/' } } : {})

phase('Threat model')
const models = await pipeline(components, (c) =>
  agent(
    [
      'Write a short threat model for one component: its entry points, who controls each input, the assets it touches, and the trust boundaries. Read the code' + (homelab ? ' and configs (Proxmox, LXC, services) read-only; change nothing' : '') + '.',
      'Component: ' + c.name + ' at ' + c.path,
    ].join('\n\n'),
    { label: 'threat ' + c.name, phase: 'Threat model', agentType: 'explore', ...where(c) },
  ),
)

phase('Research')
const LENSES = ['injection and command execution', 'authentication and authorization', 'path and file handling', 'secrets and data exposure', 'network exposure and SSRF']
const cells = []
components.forEach((c, i) => LENSES.forEach((l) => cells.push({ c, l, model: models[i] })))
const research = (await pipeline(cells, (x) =>
  agent(
    [
      'Find security bugs in one component through one lens. For each: the source (who controls the input), the sink, the path between them with file:line steps, the precondition, the cited line as quote, and a priority P0 to P3. Report every candidate; a panel filters later.',
      'Lens: ' + x.l,
      'Component: ' + x.c.name + ' at ' + x.c.path,
      x.model ? lib.fence('threat-model', x.model) : '',
    ].filter(Boolean).join('\n\n'),
    { label: x.c.name + ' / ' + x.l, phase: 'Research', agentType: 'security', schema: lib.schemas.findings, ...where(x.c) },
  ),
)).filter(Boolean)
const read = new Set(research.flatMap((r) => r.read || []))

phase('Sweep')
let sweepFindings = []
if (!homelab) {
  const all = (await lib.exec('git ls-files')).stdout.split('\n').filter(Boolean)
  const unread = all.filter((f) => !read.has(f) && /\.(ts|tsx|js|py|go|rs|sh|kt|java|rb|php)$/.test(f)).slice(0, 200)
  if (unread.length) {
    const sweep = await agent(
      ['Sweep source files the component passes did not read for security bugs. Same rules: source, sink, path, precondition, quote, priority.', lib.fence('files', unread.join('\n'))].join('\n\n'),
      { label: 'sweep', phase: 'Sweep', agentType: 'security', schema: lib.schemas.findings },
    )
    sweepFindings = sweep ? sweep.findings : []
    for (const f of (sweep && sweep.read) || []) read.add(f)
  }
}

const candidates = lib.dedupe(research.flatMap((r) => r.findings || []).concat(sweepFindings))
const cited = homelab ? { kept: candidates, dropped: 0 } : await lib.checkCitations(candidates)
const notExcluded = []
const excluded = {}
for (const f of cited.kept) {
  const rule = hardExcluded(f)
  if (rule) excluded[rule.why] = (excluded[rule.why] || 0) + 1
  else notExcluded.push(f)
}
const excludedCount = cited.kept.length - notExcluded.length
if (excludedCount) log('Dropped ' + excludedCount + ' by the hard exclusions: ' + Object.entries(excluded).map(([k, v]) => k + ' ' + v).join(', '))
const fresh = await lib.dropDismissed(notExcluded)

phase('Panel')
const exclusionText = 'Hard exclusions: a finding in one of these classes counts as refuted:\n' + exclusions.map((e) => '- ' + e).join('\n')
const judged = await pipeline(fresh, (f) =>
  lib.panel(f, {
    phase: 'Panel',
    agentType: 'verifier',
    effort: 'xhigh',
    model: 'deep',
    lenses: [
      'REACHABILITY: can an attacker actually get input from the source to the sink, past every check on the path? Default to refuted.',
      'IMPACT: if it triggers, what does the attacker gain on this owner\'s setup (a single person\'s homelab and laptops)? Default to refuted for no real gain.',
      'DEFENSES: does anything on the path already stop it (validation, auth, sandboxing, network position)? Default to refuted.',
    ],
    context: exclusionText,
  }).then((p) => (p.kept ? { ...f, priority: p.severity || f.priority, confidence: p.confidence, votes: p.votes.map((v) => v && v.verdict) } : null)),
)
const findings = judged.filter(Boolean)

phase('Report')
const line = (f) => '- ' + f.priority + ' ' + f.file + ':' + f.line + ' ' + f.title + '. Source to sink: ' + (f.scenario || '')
return {
  findings,
  report: [
    findings.length ? 'Confirmed by 2 or 3 of 3 panel votes:\n' + findings.map(line).join('\n') : 'No finding survived the REACHABILITY, IMPACT and DEFENSES panel.',
    '\nCoverage: ' + components.length + (components.length === 1 ? ' component' : ' components') + ' x ' + LENSES.length + ' lenses, ' + read.size + ' files read. Dropped: ' + cited.dropped + ' citation, ' + excludedCount + ' hard exclusions, ' + (notExcluded.length - fresh.length) + ' dismissed before, ' + (fresh.length - findings.length) + ' refuted.',
  ].join('\n'),
  coverage: { components: components.map((c) => c.name), read: [...read] },
}
