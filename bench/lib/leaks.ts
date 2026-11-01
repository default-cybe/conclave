/**
 * Leak probes, the same for both arms. A probe holds:
 * - markers: path fragments that point into hidden material (the bench task
 *   folders, results, runner state, hidden test and reference folders);
 * - canaries: lines from the task's hidden tests that appear nowhere in the
 *   visible repo, the prompt or any other task's hidden tests.
 *
 * A run is a leak suspect when the agent names a marker path in a tool call,
 * is shown a marker path in a tool result, or is shown at least two canary
 * lines that it did not write itself. Lines the agent wrote (in any tool call
 * input) do not count, so a test file the model writes from memory and reads
 * back is not a leak.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Call } from './metrics';
import type { Task } from './tasks';
import { BENCH_DIR, listFiles } from './util';

export interface LeakProbe {
  markers: string[];
  canaries: string[];
}

export const CANARY_THRESHOLD = 2;

const PATH_FRAGMENTS = ['/hidden/tests/', '/hidden/reference/', '/hidden/naive/', '/polyglot-benchmark/', '/.meta/example', '/.meta/proof'];

/** Marker paths for a set: the bench folders that hold tasks, results and runner state. */
export function leakMarkers(extra: string[] = []): string[] {
  const out = new Set<string>(PATH_FRAGMENTS);
  for (const d of ['tasks', 'fixtures', 'results', '.state', 'third_party']) out.add(join(BENCH_DIR, d) + '/');
  for (const e of extra) if (e) out.add(e.endsWith('/') ? e : e + '/');
  return [...out];
}

function textFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const rel of listFiles(dir, ['node_modules/', 'target/', '__pycache__/', '.git/'])) {
    try {
      const buf = readFileSync(join(dir, rel));
      if (buf.includes(0)) continue;
      out.push(buf.toString('utf8'));
    } catch {
      /* unreadable */
    }
  }
  return out;
}

function candidateLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= 24 && /[A-Za-z]{3}/.test(l));
}

/** Canary lines per task: hidden test lines that are specific to that task. */
export function buildCanaries(tasks: Task[], prompts: Map<string, string>): Map<string, string[]> {
  const perTask = new Map<string, Set<string>>();
  const seenIn = new Map<string, number>();
  for (const t of tasks) {
    const hiddenTests = join(t.dir, 'hidden', 'tests');
    const lines = new Set(textFiles(hiddenTests).flatMap(candidateLines));
    perTask.set(t.id, lines);
    for (const l of lines) seenIn.set(l, (seenIn.get(l) ?? 0) + 1);
  }
  const out = new Map<string, string[]>();
  for (const t of tasks) {
    const visible = textFiles(join(t.dir, 'repo')).join('\n') + '\n' + (prompts.get(t.id) ?? '');
    const keep = [...(perTask.get(t.id) ?? [])].filter((l) => (seenIn.get(l) ?? 0) === 1 && !visible.includes(l));
    out.set(t.id, keep.slice(0, 400));
  }
  return out;
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : typeof b?.content === 'string' ? b.content : '')).join('\n');
  return '';
}

/**
 * Every string inside a tool input, at any depth, so lines written through
 * nested fields (MultiEdit edits[].new_string) match line by line. A string
 * that holds JSON (OpenAI function arguments, an input sent as text) is
 * parsed and walked too.
 */
export function inputStrings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 20) return out;
  if (typeof v === 'string') {
    out.push(v);
    const t = v.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        inputStrings(JSON.parse(t), out, depth + 1);
      } catch {
        /* not JSON */
      }
    }
  } else if (Array.isArray(v)) {
    for (const x of v) inputStrings(x, out, depth + 1);
  } else if (v && typeof v === 'object') {
    for (const x of Object.values(v)) inputStrings(x, out, depth + 1);
  }
  return out;
}

/** Split a request body into what the agent wrote (tool call inputs) and what it was shown (tool results). */
export function splitConversation(body: any): { calls: string; results: string } {
  const calls: string[] = [];
  const results: string[] = [];
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    if (m?.role === 'tool') results.push(blockText(m.content)); // OpenAI shape
    if (Array.isArray(m?.tool_calls)) for (const tc of m.tool_calls) inputStrings(String(tc?.function?.arguments ?? ''), calls);
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content) {
      if (b?.type === 'tool_use') {
        try {
          calls.push(typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {}));
          // the raw strings too, at any depth, so multi-line inputs match line by line
          inputStrings(b.input ?? {}, calls);
        } catch {
          /* ignore */
        }
      } else if (b?.type === 'tool_result') results.push(blockText(b.content));
    }
  }
  return { calls: calls.join('\n'), results: results.join('\n') };
}

export interface ScanResult {
  markerInCalls: string[];
  markerInResults: string[];
  canaryLines: string[];
}

export function scanTexts(calls: string, results: string, probe: LeakProbe): ScanResult {
  const markerInCalls = probe.markers.filter((m) => calls.includes(m));
  const markerInResults = probe.markers.filter((m) => results.includes(m));
  const canaryLines = probe.canaries.filter((c) => results.includes(c) && !calls.includes(c));
  return { markerInCalls, markerInResults, canaryLines };
}

export function scanRequest(body: any, probe: LeakProbe): ScanResult {
  const s = splitConversation(body);
  return scanTexts(s.calls, s.results, probe);
}

/** The same scan over a harness transcript, for runs the tap did not see. */
export function scanCalls(calls: Call[], probe: LeakProbe): ScanResult {
  const inputs: string[] = [];
  for (const c of calls) {
    try {
      inputs.push(JSON.stringify(c.input));
    } catch {
      /* ignore */
    }
    inputStrings(c.input ?? {}, inputs);
  }
  return scanTexts(inputs.join('\n'), calls.map((c) => c.result).join('\n'), probe);
}

export function isLeak(s: ScanResult): boolean {
  return s.markerInCalls.length > 0 || s.markerInResults.length > 0 || s.canaryLines.length >= CANARY_THRESHOLD;
}

export function leakEvidence(s: ScanResult, source: string): string[] {
  const out: string[] = [];
  for (const m of s.markerInCalls) out.push(`${source}: named ${m} in a tool call`);
  for (const m of s.markerInResults) out.push(`${source}: was shown ${m} in a tool result`);
  if (s.canaryLines.length) out.push(`${source}: was shown ${s.canaryLines.length} hidden test line(s) it did not write, e.g. ${JSON.stringify(s.canaryLines[0].slice(0, 80))}`);
  return out;
}
