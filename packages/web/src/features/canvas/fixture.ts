/**
 * Mock data for the Canvas mode design (design/canvas-mode SPEC.md). The
 * real build reads flows from GET /api/sessions/:id/flows and workflows from
 * the workflow library; this file stands in so the mock is clickable.
 * shortcut: fixture only, PR 1 replaces it with the hub's file list and graphs.
 */
import type { NodeRunState } from '@conclave/core/client';

/** A port's type, shown as text beside its name (ComfyUI colors them; SPEC 3 keeps color for state). */
export type PortType = 'text' | 'json' | 'files' | 'diff' | 'number' | 'bool' | 'any';

export interface Port {
  name: string;
  type: PortType;
  optional?: boolean;
}

export interface Widget {
  name: string;
  kind: 'text' | 'number' | 'combo' | 'toggle';
  value: string | number | boolean;
  options?: string[];
}

export interface CNode {
  id: string;
  /** The library entry it came from. */
  kind: string;
  x: number;
  y: number;
  inputs: Port[];
  outputs: Port[];
  widgets: Widget[];
  state?: NodeRunState;
  /** 0 to 1 while running. */
  progress?: number;
  /** "3 of 5 steps" */
  step?: string;
  startedAt?: number;
  /** What it spent or took, once done: "41 s, 12.4K tokens, $0.18". */
  spent?: string;
  /** The value's short form, shown on the node and on its wires. */
  summary?: string;
  error?: string;
  /** Its lines in the file. */
  lines?: string;
  source?: string;
}

export interface CEdge {
  id: string;
  from: string;
  out: string;
  to: string;
  in: string;
}

export interface CGroup {
  id: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type FileKind = 'program' | 'workflow';

export interface CanvasFile {
  kind: FileKind;
  name: string;
  /** flows/scraper.flow.ts, or the workflow's id. */
  path: string;
  /** Where it lives: a project folder on a device, or Yours and Library. */
  where: string;
  device?: string;
  nodes: CNode[];
  edges: CEdge[];
  groups: CGroup[];
  readOnly?: string;
}

/** One entry of the node library. */
export interface LibraryItem {
  kind: string;
  title: string;
  help: string;
  family: string;
  /** Programs, workflows or both. */
  for: FileKind | 'both';
  inputs: Port[];
  outputs: Port[];
  widgets: Widget[];
}

export const FAMILIES = ['Inputs', 'Agents', 'People', 'Data', 'Code', 'Flow'] as const;

export const LIBRARY: LibraryItem[] = [
  { kind: 'args', title: 'Args', help: 'What the run starts with', family: 'Inputs', for: 'workflow', inputs: [], outputs: [{ name: 'task', type: 'text' }], widgets: [{ name: 'task', kind: 'text', value: '' }] },
  { kind: 'value', title: 'Value', help: 'A fixed text, number or list', family: 'Inputs', for: 'both', inputs: [], outputs: [{ name: 'value', type: 'any' }], widgets: [{ name: 'value', kind: 'text', value: '' }] },
  { kind: 'readFiles', title: 'Read files', help: 'Files that match a pattern', family: 'Inputs', for: 'both', inputs: [], outputs: [{ name: 'files', type: 'files' }], widgets: [{ name: 'pattern', kind: 'text', value: 'src/**/*.ts' }] },
  { kind: 'agent', title: 'Agent', help: 'One agent call', family: 'Agents', for: 'workflow', inputs: [{ name: 'prompt', type: 'text' }], outputs: [{ name: 'reply', type: 'text' }], widgets: [{ name: 'agent', kind: 'combo', value: 'coder', options: ['coder', 'planner', 'reviewer', 'security'] }, { name: 'model', kind: 'combo', value: 'Sonnet 5.5', options: ['Sonnet 5.5', 'Opus 5', 'GPT-5.5', 'GLM-5'] }] },
  { kind: 'parallel', title: 'Parallel', help: 'Several agents at once', family: 'Agents', for: 'workflow', inputs: [{ name: 'prompt', type: 'text' }], outputs: [{ name: 'replies', type: 'json' }], widgets: [{ name: 'count', kind: 'number', value: 3 }] },
  { kind: 'approve', title: 'Approve', help: 'Wait for your yes', family: 'People', for: 'both', inputs: [{ name: 'show', type: 'any' }], outputs: [{ name: 'ok', type: 'bool' }], widgets: [] },
  { kind: 'ask', title: 'Ask', help: 'A question for you', family: 'People', for: 'both', inputs: [{ name: 'context', type: 'any', optional: true }], outputs: [{ name: 'answer', type: 'text' }], widgets: [{ name: 'question', kind: 'text', value: '' }] },
  { kind: 'fetchUrl', title: 'Fetch URL', help: 'GET or POST a URL', family: 'Data', for: 'both', inputs: [{ name: 'url', type: 'text' }], outputs: [{ name: 'data', type: 'json' }], widgets: [{ name: 'as', kind: 'combo', value: 'json', options: ['json', 'text'] }, { name: 'method', kind: 'combo', value: 'GET', options: ['GET', 'POST'] }] },
  { kind: 'pick', title: 'Pick', help: 'One field of a value', family: 'Data', for: 'program', inputs: [{ name: 'from', type: 'json' }], outputs: [{ name: 'value', type: 'any' }], widgets: [{ name: 'field', kind: 'text', value: '' }] },
  { kind: 'filter', title: 'Filter', help: 'Keep the items that match', family: 'Data', for: 'program', inputs: [{ name: 'items', type: 'json' }], outputs: [{ name: 'items', type: 'json' }], widgets: [{ name: 'field', kind: 'text', value: '' }, { name: 'op', kind: 'combo', value: 'contains', options: ['contains', 'equals', 'above', 'below'] }, { name: 'value', kind: 'text', value: '' }] },
  { kind: 'writeCsv', title: 'Write CSV', help: 'Rows to a CSV file', family: 'Data', for: 'program', inputs: [{ name: 'rows', type: 'json' }], outputs: [{ name: 'path', type: 'text' }], widgets: [{ name: 'path', kind: 'text', value: 'out/rows.csv' }] },
  { kind: 'check', title: 'Check', help: 'Run a command, pass on exit 0', family: 'Code', for: 'both', inputs: [{ name: 'after', type: 'any', optional: true }], outputs: [{ name: 'output', type: 'text' }], widgets: [{ name: 'command', kind: 'text', value: 'bun test' }] },
  { kind: 'code', title: 'Code', help: 'TypeScript the blocks do not cover', family: 'Code', for: 'both', inputs: [{ name: 'in', type: 'any' }], outputs: [{ name: 'out', type: 'any' }], widgets: [] },
  { kind: 'loop', title: 'Loop until', help: 'Repeat until a check passes', family: 'Flow', for: 'workflow', inputs: [{ name: 'body', type: 'any' }], outputs: [{ name: 'last', type: 'any' }], widgets: [{ name: 'max', kind: 'number', value: 5 }] },
  { kind: 'subflow', title: 'Sub-workflow', help: 'Another workflow as one node', family: 'Flow', for: 'workflow', inputs: [{ name: 'args', type: 'any' }], outputs: [{ name: 'result', type: 'any' }], widgets: [{ name: 'workflow', kind: 'combo', value: 'quick-review', options: ['quick-review', 'fix-until-green', 'deep-research'] }] },
  { kind: 'log', title: 'Log', help: 'Print a value to the output', family: 'Flow', for: 'both', inputs: [{ name: 'value', type: 'any' }], outputs: [], widgets: [] },
  { kind: 'return', title: 'Result', help: 'What the run gives back', family: 'Flow', for: 'workflow', inputs: [{ name: 'value', type: 'any' }], outputs: [], widgets: [] },
];

export const libraryItem = (kind: string) => LIBRARY.find((l) => l.kind === kind);

/** 0 title starts with it, 1 a title word does, 2 title has it, 3 help or family has it, 9 no match. */
export function nodeRank(x: Pick<LibraryItem, 'title' | 'help' | 'family'>, term: string): number {
  const t = x.title.toLowerCase();
  if (!term || t.startsWith(term)) return 0;
  if (t.split(/\s+/).some((w) => w.startsWith(term))) return 1;
  if (t.includes(term)) return 2;
  return `${x.help} ${x.family}`.toLowerCase().includes(term) ? 3 : 9;
}

/** The library for a file kind: by family when nothing is typed, else best match first (graph audit 10: "fil" must pick Filter). */
export function searchLibrary(kind: FileKind, term: string): LibraryItem[] {
  const fits = LIBRARY.filter((x) => (x.for === 'both' || x.for === kind) && nodeRank(x, term) < 9);
  const fam = (x: LibraryItem) => FAMILIES.indexOf(x.family as (typeof FAMILIES)[number]);
  return fits.sort((a, b) => (term ? nodeRank(a, term) - nodeRank(b, term) : 0) || fam(a) - fam(b));
}

const ago = (s: number) => Date.now() - s * 1000;

/** A Code workflow mid-run: one node in each state the canvas draws. */
const REVIEW: CanvasFile = {
  kind: 'workflow',
  name: 'review-and-fix',
  path: 'workflows/review-and-fix.ts',
  where: 'Yours',
  device: 'arch-desktop',
  nodes: [
    { id: 'task', kind: 'args', x: 0, y: 40, inputs: [], outputs: [{ name: 'task', type: 'text' }], widgets: [{ name: 'task', kind: 'text', value: 'Move auth middleware to jose' }], state: 'done', spent: '0 ms', summary: '"Move auth middleware to jose"', lines: 'L3' },
    { id: 'docs', kind: 'fetchUrl', x: 0, y: 250, inputs: [{ name: 'url', type: 'text' }], outputs: [{ name: 'data', type: 'json' }], widgets: [{ name: 'as', kind: 'combo', value: 'text', options: ['json', 'text'] }, { name: 'method', kind: 'combo', value: 'GET', options: ['GET', 'POST'] }], state: 'failed', error: 'HTTP 404 from github.com/panva/jose/docs/README.md', lines: 'L4' },
    {
      id: 'plan',
      kind: 'agent',
      x: 330,
      y: 90,
      inputs: [{ name: 'prompt', type: 'text' }, { name: 'docs', type: 'json', optional: true }],
      outputs: [{ name: 'plan', type: 'text' }],
      widgets: [{ name: 'agent', kind: 'combo', value: 'planner', options: ['coder', 'planner', 'reviewer', 'security'] }, { name: 'model', kind: 'combo', value: 'Opus 5', options: ['Sonnet 5.5', 'Opus 5', 'GPT-5.5', 'GLM-5'] }],
      state: 'done',
      spent: '41 s, 12.4K tokens, $0.18',
      summary: '5 steps',
      lines: 'L6-12',
    },
    {
      id: 'implement',
      kind: 'agent',
      x: 660,
      y: 90,
      inputs: [{ name: 'prompt', type: 'text' }],
      outputs: [{ name: 'diff', type: 'diff' }],
      widgets: [{ name: 'agent', kind: 'combo', value: 'coder', options: ['coder', 'planner', 'reviewer', 'security'] }, { name: 'model', kind: 'combo', value: 'Sonnet 5.5', options: ['Sonnet 5.5', 'Opus 5', 'GPT-5.5', 'GLM-5'] }],
      state: 'running',
      progress: 0.6,
      step: '3 of 5 steps',
      startedAt: ago(72),
      lines: 'L14-22',
      source: "const diff = await agent({\n  agentType: 'coder',\n  model: 'Sonnet 5.5',\n  prompt: `Do this plan in ${args.cwd}:\\n${plan}`,\n});",
    },
    { id: 'security', kind: 'agent', x: 1010, y: 40, inputs: [{ name: 'prompt', type: 'diff' }], outputs: [{ name: 'notes', type: 'text' }], widgets: [{ name: 'agent', kind: 'combo', value: 'security', options: ['coder', 'planner', 'reviewer', 'security'] }, { name: 'model', kind: 'combo', value: 'GLM-5', options: ['Sonnet 5.5', 'Opus 5', 'GPT-5.5', 'GLM-5'] }], state: 'queued', lines: 'L25-28' },
    { id: 'style', kind: 'agent', x: 1010, y: 270, inputs: [{ name: 'prompt', type: 'diff' }], outputs: [{ name: 'notes', type: 'text' }], widgets: [{ name: 'agent', kind: 'combo', value: 'reviewer', options: ['coder', 'planner', 'reviewer', 'security'] }, { name: 'model', kind: 'combo', value: 'GPT-5.5', options: ['Sonnet 5.5', 'Opus 5', 'GPT-5.5', 'GLM-5'] }], state: 'queued', lines: 'L29-32' },
    { id: 'tests', kind: 'check', x: 1360, y: 150, inputs: [{ name: 'after', type: 'any', optional: true }], outputs: [{ name: 'output', type: 'text' }], widgets: [{ name: 'command', kind: 'text', value: 'bun test' }], state: 'queued', lines: 'L34' },
    { id: 'ship', kind: 'approve', x: 1680, y: 150, inputs: [{ name: 'show', type: 'any' }], outputs: [{ name: 'ok', type: 'bool' }], widgets: [], state: 'queued', lines: 'L36' },
  ],
  edges: [
    { id: 'e1', from: 'task', out: 'task', to: 'plan', in: 'prompt' },
    { id: 'e2', from: 'docs', out: 'data', to: 'plan', in: 'docs' },
    { id: 'e3', from: 'plan', out: 'plan', to: 'implement', in: 'prompt' },
    { id: 'e4', from: 'implement', out: 'diff', to: 'security', in: 'prompt' },
    { id: 'e5', from: 'implement', out: 'diff', to: 'style', in: 'prompt' },
    { id: 'e6', from: 'security', out: 'notes', to: 'tests', in: 'after' },
    { id: 'e7', from: 'style', out: 'notes', to: 'tests', in: 'after' },
    { id: 'e8', from: 'tests', out: 'output', to: 'ship', in: 'show' },
  ],
  groups: [{ id: 'g1', title: 'Review', x: 990, y: 0, w: 300, h: 470 }],
};

/** A program: flows/scraper.flow.ts in the conclave project, its last run failed at the code block. */
const SCRAPER: CanvasFile = {
  kind: 'program',
  name: 'scraper',
  path: 'flows/scraper.flow.ts',
  where: 'conclave',
  device: 'arch-desktop',
  nodes: [
    { id: 'data', kind: 'fetchUrl', x: 0, y: 60, inputs: [{ name: 'url', type: 'text' }], outputs: [{ name: 'data', type: 'json' }], widgets: [{ name: 'as', kind: 'combo', value: 'json', options: ['json', 'text'] }, { name: 'method', kind: 'combo', value: 'GET', options: ['GET', 'POST'] }], state: 'done', spent: '412 ms', summary: '{ hits, nbHits, page }', lines: 'L5' },
    { id: 'posts', kind: 'pick', x: 320, y: 60, inputs: [{ name: 'from', type: 'json' }], outputs: [{ name: 'value', type: 'any' }], widgets: [{ name: 'field', kind: 'text', value: 'hits' }], state: 'done', spent: '0 ms', summary: '30 items', lines: 'L6' },
    { id: 'bun', kind: 'filter', x: 640, y: 60, inputs: [{ name: 'items', type: 'json' }], outputs: [{ name: 'items', type: 'json' }], widgets: [{ name: 'field', kind: 'text', value: 'title' }, { name: 'op', kind: 'combo', value: 'contains', options: ['contains', 'equals', 'above', 'below'] }, { name: 'value', kind: 'text', value: 'bun' }], state: 'done', spent: '1 ms', summary: '0 items', lines: 'L7' },
    { id: 'csv', kind: 'writeCsv', x: 960, y: 0, inputs: [{ name: 'rows', type: 'json' }], outputs: [{ name: 'path', type: 'text' }], widgets: [{ name: 'path', kind: 'text', value: 'out/posts.csv' }], state: 'done', spent: '3 ms', summary: 'out/posts.csv', lines: 'L8' },
    { id: 'top', kind: 'code', x: 960, y: 220, inputs: [{ name: 'in', type: 'any' }], outputs: [{ name: 'out', type: 'any' }], widgets: [], state: 'failed', error: "TypeError: undefined is not an object (evaluating 'bun.sort(...)[0].title')", lines: 'L9', source: 'const top = bun.sort((a, b) => b.points - a.points)[0].title;' },
    { id: 'print', kind: 'log', x: 1280, y: 220, inputs: [{ name: 'value', type: 'any' }], outputs: [], widgets: [], state: 'skipped', lines: 'L10' },
  ],
  edges: [
    { id: 's1', from: 'data', out: 'data', to: 'posts', in: 'from' },
    { id: 's2', from: 'posts', out: 'value', to: 'bun', in: 'items' },
    { id: 's3', from: 'bun', out: 'items', to: 'csv', in: 'rows' },
    { id: 's4', from: 'bun', out: 'items', to: 'top', in: 'in' },
    { id: 's5', from: 'top', out: 'out', to: 'print', in: 'value' },
  ],
  groups: [],
};

const empty = (kind: FileKind, name: string, path: string, where: string, device?: string, readOnly?: string): CanvasFile => ({ kind, name, path, where, device, nodes: [], edges: [], groups: [], readOnly });

export const FILES: CanvasFile[] = [
  SCRAPER,
  empty('program', 'release-notes', 'flows/release-notes.flow.ts', 'conclave', 'arch-desktop'),
  empty('program', 'backup-report', 'flows/backup-report.flow.ts', 'homelab', 'madx'),
  REVIEW,
  empty('workflow', 'nightly-triage', 'workflows/nightly-triage.ts', 'Yours'),
  empty('workflow', 'fix-until-green', 'fix-until-green', 'Library', undefined, 'This workflow ships with Conclave. Copy it to your workflows to edit it.'),
  empty('workflow', 'quick-review', 'quick-review', 'Library', undefined, 'This workflow ships with Conclave. Copy it to your workflows to edit it.'),
];

export const fileHref = (f: Pick<CanvasFile, 'kind' | 'name'>) => `/canvas/${f.kind}/${f.name}`;
export const findFile = (kind?: string, name?: string) => FILES.find((f) => f.kind === kind && f.name === name);

/** The run queue the bottom panel lists (ComfyUI's queue): what runs now, what waits, what ran. */
export const QUEUE = [
  { name: 'review-and-fix', state: 'running' as const, words: '3 of 8 done, $0.41', since: ago(72) },
  { name: 'scraper.flow.ts', state: 'queued' as const, words: 'on arch-desktop, after this run' },
  { name: 'nightly-triage', state: 'done' as const, words: 'done 2 h ago, 1:48, $0.62' },
  { name: 'scraper.flow.ts', state: 'failed' as const, words: 'failed 3 h ago at top, L9' },
];

export const SCRAPER_LOGS = [
  ['11:02:17', 'data', 'GET hn.algolia.com/api/v1/search, 200, 412 ms'],
  ['11:02:17', 'posts', '30 items'],
  ['11:02:17', 'bun', '0 items match title contains "bun"'],
  ['11:02:17', 'csv', 'Wrote out/posts.csv, 0 rows'],
  ['11:02:17', 'top', "Failed. TypeError: undefined is not an object (evaluating 'bun.sort(...)[0].title')"],
  ['11:02:17', 'print', 'Skipped, top failed'],
] as const;

export const LOGS = [
  ['12:04:02', 'task', 'Args set'],
  ['12:04:02', 'docs', 'Failed. HTTP 404 from github.com/panva/jose/docs/README.md'],
  ['12:04:03', 'plan', 'Agent planner on Opus 5 started, docs is optional, went on without it'],
  ['12:04:44', 'plan', 'Done in 41 s, 5 steps'],
  ['12:04:44', 'implement', 'Agent coder on Sonnet 5.5 started'],
  ['12:05:10', 'implement', 'Edit src/auth/middleware.ts'],
  ['12:05:31', 'implement', 'Bash bun run typecheck, exit 0'],
  ['12:05:52', 'implement', 'Edit src/auth/verify.ts'],
] as const;
