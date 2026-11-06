/**
 * Canvas mode's pure parts (docs/design/CANVAS-MODE.md): what a file is and
 * its address, the last file open, which session reads a program's folder,
 * and where the canvas opens on a phone. No React here, so tests import it.
 */
import type { WorkflowRun, WorkflowSummary } from '@conclave/core/client';
import type { Session } from '@conclave/core/types';
import { underParent } from '@conclave/core/session/delegated';
import { sideModeOf } from '@/lib/sidebar';
import { accountKey } from '@/lib/api';
import { isLive } from '../workflows/words';

/** A program is flows/<name>.flow.ts in a folder on a device; a workflow is yours or the library's, or one run of it. */
export type CanvasFile =
  | { kind: 'program'; name: string; device: string; cwd: string; sessionId: string }
  | { kind: 'workflow'; id: string; name: string; group: 'yours' | 'library' | 'runs'; runId?: string; live?: boolean; failed?: boolean };

export function programHref(name: string, device: string, cwd: string): string {
  return `/canvas/program/${encodeURIComponent(name)}?${new URLSearchParams({ device, cwd })}`;
}

/** /canvas/workflow/<id or run>: a workflow's id, or a run's (wfr_...), which shows that run's own script lit by its state. */
export function workflowHref(idOrRun: string): string {
  return `/canvas/workflow/${encodeURIComponent(idOrRun)}`;
}

/** A Code session's Open in Canvas: its first program in that folder, else Canvas's start page (no program yet). */
export function sessionCanvasHref(session: Pick<Session, 'device' | 'cwd'>, flows: Array<{ name: string }>): string {
  return flows[0] && session.cwd ? programHref(flows[0].name, session.device, session.cwd) : '/canvas';
}

/** Old graph addresses (/workflows/graph/:id, a run's ?view=graph) and where they live now. */
export function oldGraphRedirect(path: string, search: string): string | undefined {
  const g = /^\/workflows\/graph\/([^/]+)\/?$/.exec(path);
  if (g) return workflowHref(decodeURIComponent(g[1]));
  const r = /^\/workflows\/runs\/([^/]+)\/?$/.exec(path);
  if (r && new URLSearchParams(search).get('view') === 'graph') return workflowHref(decodeURIComponent(r[1]));
  return undefined;
}

export const isRunId = (s: string) => s.startsWith('wfr_');

export const fileHref = (f: CanvasFile) => (f.kind === 'program' ? programHref(f.name, f.device, f.cwd) : workflowHref(f.runId ?? f.id));

/** A node menu's Open in code: the file in its device's file browser. A built-in workflow (builtin:...) has no file to open. */
export function codeHref(device: string, path: string | undefined): string | undefined {
  if (!device || !path || path.startsWith('builtin:')) return undefined;
  const i = path.lastIndexOf('/');
  const q = new URLSearchParams({ ...(i > 0 ? { path: path.slice(0, i) } : {}), file: path });
  return `/devices/${encodeURIComponent(device)}/files?${q}`;
}

export const fileTitle = (f: CanvasFile) => (f.kind === 'program' ? `${f.name}.flow.ts` : f.name);

// ---------------------------------------------------------------------------
// The last file open: Canvas opens on it (owner decision on PR #250)
// ---------------------------------------------------------------------------

// Per account: a file's name is in its address, and several people can sign in on one browser.
// The old key, one per browser, is never read.
const LAST_KEY = 'conclave.canvas.last';

export function rememberFile(href: string) {
  try {
    if (href.startsWith('/canvas/')) localStorage.setItem(accountKey(LAST_KEY), href);
  } catch {
    /* private mode: this page only */
  }
}

// The node library at the left: open or folded, kept per account. Unset: folded while a run is read, open otherwise.
const LIBRARY_KEY = 'conclave.canvas.library';

export function libraryOpen(run: boolean): boolean {
  try {
    const v = localStorage.getItem(accountKey(LIBRARY_KEY));
    return v === null ? !run : v === '1';
  } catch {
    return !run;
  }
}

export function saveLibraryOpen(open: boolean) {
  try {
    localStorage.setItem(accountKey(LIBRARY_KEY), open ? '1' : '0');
  } catch {
    /* private mode: this page only */
  }
}

/** Where the mode switch goes: the last file open, else the start page. */
export function canvasHome(): string {
  try {
    const v = localStorage.getItem(accountKey(LAST_KEY));
    return v && v.startsWith('/canvas/') ? v : '/canvas';
  } catch {
    return '/canvas';
  }
}

// ---------------------------------------------------------------------------
// Programs: the flow routes are a session's, so a folder is read through its newest Code session
// ---------------------------------------------------------------------------

const codeSession = (s: Session) => !s.archived && !underParent(s) && sideModeOf(s) === 'code' && !!s.cwd;

/** The newest Code session of each folder (device and cwd), newest folder first, at most `max`. */
export function folderSessions(sessions: Iterable<Session>, max = 12): Session[] {
  const best = new Map<string, Session>();
  for (const s of sessions) {
    if (!codeSession(s)) continue;
    const k = `${s.device}\u0000${s.cwd}`;
    const was = best.get(k);
    if (!was || s.updatedAt > was.updatedAt) best.set(k, s);
  }
  return [...best.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, max);
}

/** The session the canvas reads a program through: the newest Code session in that folder on that device. */
export function sessionFor(sessions: Iterable<Session>, device: string, cwd: string): Session | undefined {
  let out: Session | undefined;
  for (const s of sessions) if (codeSession(s) && s.device === device && s.cwd === cwd && (!out || s.updatedAt > out.updatedAt)) out = s;
  return out;
}

// ---------------------------------------------------------------------------
// Workflows: yours, the library's, and recent runs
// ---------------------------------------------------------------------------

const LIBRARY = new Set(['builtin', 'plugin', 'claude-code']);

export function workflowFiles(library: WorkflowSummary[] = [], runs: WorkflowRun[] = [], maxRuns = 8): CanvasFile[] {
  const out: CanvasFile[] = [];
  for (const w of library) out.push({ kind: 'workflow', id: w.id, name: w.name, group: LIBRARY.has(w.source) ? 'library' : 'yours' });
  // yours first, then the library; each by name
  out.sort((a, b) => (a.kind === 'workflow' && b.kind === 'workflow' ? Number(a.group === 'library') - Number(b.group === 'library') || a.name.localeCompare(b.name) : 0));
  for (const r of [...runs].sort((a, b) => b.createdAt - a.createdAt).slice(0, maxRuns))
    out.push({ kind: 'workflow', id: r.name, name: r.name, group: 'runs', runId: r.id, live: isLive(r.status), failed: r.status === 'failed' });
  return out;
}

/** The sidebar's groups: each program folder, then Your workflows, Library workflows, Recent runs. */
export function fileGroups(files: CanvasFile[], folderLabel: (f: Extract<CanvasFile, { kind: 'program' }>) => string): Array<{ label: string; files: CanvasFile[] }> {
  const WORDS = { yours: 'Your workflows', library: 'Library workflows', runs: 'Recent runs' } as const;
  const out: Array<{ label: string; files: CanvasFile[] }> = [];
  for (const f of files) {
    const label = f.kind === 'program' ? folderLabel(f) : WORDS[f.group];
    const g = out.find((x) => x.label === label) ?? out[out.push({ label, files: [] }) - 1];
    g.files.push(f);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Where the canvas opens
// ---------------------------------------------------------------------------

/** The node the phone opens on: the running one, else one waiting on you, else the first failed one. */
export function focusNode(states: Array<{ id: string; state?: string }>): string | undefined {
  for (const want of ['running', 'waiting', 'failed']) {
    const hit = states.find((s) => s.state === want);
    if (hit) return hit.id;
  }
  return undefined;
}

/** The block the top bar's Go to button reaches: the first failed one, else the first running one. */
export function goTarget(states: Array<{ id: string; state?: string }>): { id: string; word: 'failed' | 'running' } | undefined {
  for (const word of ['failed', 'running'] as const) {
    const hit = states.find((s) => s.state === word);
    if (hit) return { id: hit.id, word };
  }
  return undefined;
}

type Box = { x: number; y: number; w: number; h: number };

/** Whether any part of a node (flow coordinates) shows in the pane at the viewport. */
export function onScreen(node: Box, vp: { x: number; y: number; zoom: number }, canvas: { w: number; h: number }): boolean {
  const l = node.x * vp.zoom + vp.x;
  const t = node.y * vp.zoom + vp.y;
  return l + node.w * vp.zoom > 0 && l < canvas.w && t + node.h * vp.zoom > 0 && t < canvas.h;
}

/** The Go to button's words: only when there is a target and it is off screen. */
export function goLabel(target: { word: 'failed' | 'running' } | undefined, offScreen: boolean): string | undefined {
  return target && offScreen ? `Go to ${target.word} block` : undefined;
}

export const READ_ZOOM = 0.55;

/**
 * A computer's first view (owner on #253): readable, the first blocks on
 * screen, and the pane's height used. The zoom is the height's fit, at
 * most 1:1 and never below READ_ZOOM, so a short wide graph opens larger
 * than its width fit and runs off the right. The start stays at the left;
 * a graph narrower than the pane is centred. The running or failed node is
 * in the inspector and the minimap; across, it only picks where a graph
 * taller than the pane sits.
 */
export function deskViewport(graph: Box, focus: Box | undefined, canvas: { w: number; h: number }, pad = 24): { x: number; y: number; zoom: number } {
  const zoom = Math.max(READ_ZOOM, Math.min(1, (canvas.h - pad * 2) / Math.max(graph.h, 1)));
  const x = graph.w * zoom <= canvas.w - pad * 2 ? (canvas.w - graph.w * zoom) / 2 - graph.x * zoom : pad - graph.x * zoom;
  // the graph centred when it fits, else the focus (or the top) in the middle
  const y = graph.h * zoom <= canvas.h - pad * 2 ? (canvas.h - graph.h * zoom) / 2 - graph.y * zoom : focus ? canvas.h / 2 - (focus.y + focus.h / 2) * zoom : pad - graph.y * zoom;
  return { x, y, zoom };
}

/**
 * The viewport that puts `node` on screen at `zoom` with the nodes before it
 * above (a phone's column runs top to bottom): the node sits at about 60% of
 * the height, then the view is pulled back so no empty band shows above the
 * graph's top or below its bottom while the graph is taller than the screen.
 * Across, the graph is centred when it fits, else the node is.
 */
export function focusViewport(node: Box, graph: Box, canvas: { w: number; h: number }, zoom = 1, pad = 12): { x: number; y: number; zoom: number } {
  const gw = graph.w * zoom;
  const gh = graph.h * zoom;
  const x = gw + pad * 2 <= canvas.w ? (canvas.w - gw) / 2 - graph.x * zoom : canvas.w / 2 - (node.x + node.w / 2) * zoom;
  let y = canvas.h * 0.6 - (node.y + node.h / 2) * zoom;
  if (gh + pad * 2 <= canvas.h) y = pad - graph.y * zoom;
  else {
    const top = pad - graph.y * zoom; // the graph's top at the screen's top
    const bottom = canvas.h - pad - (graph.y + graph.h) * zoom; // its bottom at the screen's bottom
    y = Math.min(top, Math.max(bottom, y));
  }
  return { x, y, zoom };
}
