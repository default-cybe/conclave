/**
 * The "Isolation and parity" part of summary.md: what each arm actually sent
 * to the model (from the tap), what it could see, and whether anything leaked.
 * It reads only results.jsonl lines, so it works for old and new sets.
 */
type Row = any;

const uniq = (xs: unknown[]) => [...new Set(xs.flat().filter((x) => x !== undefined && x !== null).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))))];
const median = (xs: number[]) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

export interface ArmParity {
  arm: string;
  runs: number;
  viaTap: number;
  promptFound: number;
  promptChecked: number;
  served: string[];
  tools: string[];
  forbidden: string[];
  maxTokens: string[];
  thinking: string[];
  effort: string[];
  systemChars: number | null;
  firstRequest: number | null;
  cacheWrite1hShare: number | null;
  tokenSource: string[];
  stragglers: number;
  neighbours: number;
  foreign: number;
  benchPaths: number;
  hiddenLines: number;
  hiddenChecked: number;
  leaks: number;
  hubStartMs: number | null;
  overrunMax: number | null;
}

export function armParity(arm: string, runs: Row[]): ArmParity {
  const sent = runs.map((r) => r.sent).filter(Boolean);
  const tapped = runs.filter((r) => typeof r.tokens?.cache_write_1h === 'number');
  const cw = tapped.reduce((a, r) => a + (r.tokens?.cache_write ?? 0), 0);
  const cw1h = tapped.reduce((a, r) => a + (r.tokens?.cache_write_1h ?? 0), 0);
  return {
    arm,
    runs: runs.length,
    viaTap: runs.filter((r) => r.isolation?.tap).length,
    promptFound: sent.filter((s) => s.prompt_found === true).length,
    promptChecked: sent.filter((s) => s.prompt_found !== null && s.prompt_found !== undefined).length,
    served: uniq(runs.map((r) => r.model_served ?? [])),
    tools: uniq(sent.map((s) => s.tools ?? [])).sort(),
    forbidden: uniq(runs.map((r) => r.flags?.forbidden_tools_offered ?? [])),
    maxTokens: uniq(sent.map((s) => s.max_tokens ?? [])),
    thinking: uniq(sent.map((s) => s.thinking ?? [])),
    effort: uniq(sent.map((s) => s.effort ?? [])),
    systemChars: median(sent.map((s) => s.system_chars).filter((x) => typeof x === 'number')),
    firstRequest: median(runs.map((r) => r.requests?.first_request_tokens).filter((x) => typeof x === 'number')),
    cacheWrite1hShare: cw > 0 ? cw1h / cw : null,
    tokenSource: uniq(runs.map((r) => r.tokens?.source ?? 'none')),
    stragglers: runs.reduce((a, r) => a + (r.isolation?.stragglers_killed?.length ?? 0), 0),
    neighbours: runs.filter((r) => r.isolation?.neighbours?.length).length,
    foreign: runs.filter((r) => r.isolation?.foreign_bench_processes?.length).length,
    benchPaths: runs.filter((r) => r.isolation?.env_bench_paths?.length || r.isolation?.argv_bench_paths?.length).length,
    hiddenLines: runs.reduce((a, r) => a + (r.flags?.hidden_lines_seen ?? 0), 0),
    hiddenChecked: runs.filter((r) => typeof r.flags?.hidden_lines_seen === 'number').length,
    leaks: runs.filter((r) => r.flags?.leak_suspect).length,
    hubStartMs: median(runs.map((r) => r.isolation?.hub?.start_ms).filter((x) => typeof x === 'number')),
    overrunMax: runs.some((r) => typeof r.limit_overrun_ms === 'number') ? Math.max(...runs.map((r) => r.limit_overrun_ms ?? 0)) : null,
  };
}

/** One line for the top of the summary when the arms sent the model different settings. */
export function settingsNote(results: Row[]): string | null {
  const a = armParity('A', results.filter((r) => r.arm === 'A'));
  const b = armParity('B', results.filter((r) => r.arm === 'B'));
  if (!a.viaTap || !b.viaTap) return null;
  const diffs: string[] = [];
  const same = (x: string[], y: string[]) => x.join('|') === y.join('|');
  if (!same(a.effort, b.effort)) diffs.push(`effort A ${a.effort.join(', ') || 'none'}, B ${b.effort.join(', ') || 'none'}`);
  if (!same(a.thinking, b.thinking)) diffs.push(`thinking A ${a.thinking.join(', ') || 'none'}, B ${b.thinking.join(', ') || 'none'}`);
  if (!same(a.maxTokens, b.maxTokens)) diffs.push(`max_tokens A ${a.maxTokens.join(', ')}, B ${b.maxTokens.join(', ')}`);
  if (!diffs.length) return null;
  return `Note: the two harnesses sent the model different settings (from the tap): ${diffs.join('; ')}. These are each tool's shipped defaults. A gap may come from them, not from the rest of the harness; a --match-effort set checks this.`;
}

export function parityLines(results: Row[], arms: string[]): string[] {
  const ps = arms.map((a) => armParity(a, results.filter((r) => r.arm === a)));
  const rows: Array<[string, (p: ArmParity) => string]> = [
    ['runs through the tap', (p) => `${p.viaTap} of ${p.runs}`],
    ['prompt found byte for byte in the first request', (p) => (p.promptChecked ? `${p.promptFound} of ${p.promptChecked}` : 'n/a')],
    ['model ids the API served', (p) => p.served.join(', ') || 'n/a'],
    ['token counts from', (p) => p.tokenSource.join(', ')],
    ['effort sent', (p) => p.effort.join(', ') || 'n/a'],
    ['thinking sent', (p) => p.thinking.join(', ') || 'n/a'],
    ['max_tokens sent', (p) => p.maxTokens.join(', ') || 'n/a'],
    ['system prompt chars (median)', (p) => (p.systemChars === null ? 'n/a' : String(p.systemChars))],
    ['first request tokens (median)', (p) => (p.firstRequest === null ? 'n/a' : String(p.firstRequest))],
    ['share of cache writes at the 1 hour TTL', (p) => (p.cacheWrite1hShare === null ? 'n/a' : `${Math.round(p.cacheWrite1hShare * 100)}%`)],
    ['tools offered to the model', (p) => p.tools.join(', ') || 'n/a'],
    ['denied tools still offered', (p) => p.forbidden.join(', ') || 'none'],
    ['background processes killed after the run', (p) => String(p.stragglers)],
    ['runs whose sandbox had neighbours', (p) => String(p.neighbours)],
    ['runs with a bench path in env or argv', (p) => String(p.benchPaths)],
    ['runs with other processes naming hidden paths', (p) => String(p.foreign)],
    ['hidden test lines shown to the model (tap)', (p) => (p.hiddenChecked ? String(p.hiddenLines) : 'n/a')],
    ['leak suspects', (p) => String(p.leaks)],
    ['model calls ending after the time limit (max ms)', (p) => (p.overrunMax === null ? 'n/a' : String(p.overrunMax))],
    ['hub start (median ms, not in wall time)', (p) => (p.hubStartMs === null ? 'n/a' : String(p.hubStartMs))],
  ];
  const esc = (v: string) => v.replaceAll('|', '\\|').replaceAll('\n', ' ');
  const out = [`| | ${arms.join(' | ')} |`, `|---|${arms.map(() => '---').join('|')}|`];
  for (const [label, f] of rows) out.push(`| ${label} | ${ps.map((p) => esc(f(p))).join(' | ')} |`);
  const a = ps.find((p) => p.arm === 'A');
  const b = ps.find((p) => p.arm === 'B');
  const notes: string[] = [];
  if (a && b && a.tools.length && b.tools.length) {
    const onlyA = a.tools.filter((t) => !b.tools.includes(t));
    const onlyB = b.tools.filter((t) => !a.tools.includes(t));
    notes.push(`Tools only A offers: ${onlyA.join(', ') || 'none'}. Tools only B offers: ${onlyB.join(', ') || 'none'}. These are part of each harness.`);
  }
  if (a && b && a.tokenSource.join() !== b.tokenSource.join()) notes.push('Token counts come from different sources for A and B, so token and cost ratios compare two parsers. Run with --b-transport proxy so both go through the tap.');
  if (ps.some((p) => p.forbidden.length)) notes.push('A denied tool was offered to the model. Check the agent overrides (A) or the --disallowedTools flag (B) before trusting the set.');
  if (ps.some((p) => p.foreign)) notes.push('Other processes on the machine named hidden paths in their command line during some runs (an agent running ps would see them). Run nothing else from bench/ during a set.');
  if (ps.some((p) => p.neighbours || p.benchPaths)) notes.push('A sandbox had neighbours or a bench path in env or argv. An agent could have found other runs or the hidden tests that way.');
  return [...out, '', ...notes];
}
