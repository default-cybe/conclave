/**
 * What the session panel's cards show (ContextPanel.tsx,
 * docs/design/CHAT-AND-MOTION.md 2.11): which cards a conversation gets,
 * the files and pictures it made (Outputs), the background shells it
 * started (Background tasks), and how full its context is. Worked out from
 * the transcript on the client. Pure, so test/session-panel.test.ts checks
 * it.
 */
import type { ContentBlock, Message, Session, SessionStatus } from '@conclave/core/types';
import { compact, fileName, hhmm, usd } from '@/lib/format';
import { harnessId, modelName } from '@/lib/models';
import { planServed, type Valued } from '@/features/usage/value';

export type CardId = 'environment' | 'context' | 'connectors' | 'plan' | 'outputs' | 'changes' | 'tasks' | 'memory';

/**
 * The cards of a conversation, in order. Code has them all; the assistant
 * works on the hub with no folder of yours, so it has no Environment and no
 * Changes; a chat has its Context, what it made and the memory it used.
 */
export function panelCards(s: Pick<Session, 'kind' | 'agent'>): CardId[] {
  if (s.kind === 'chat') return ['context', 'outputs', 'memory'];
  if (s.agent === 'assistant') return ['context', 'connectors', 'plan', 'outputs', 'tasks', 'memory'];
  return ['environment', 'context', 'connectors', 'plan', 'outputs', 'changes', 'tasks', 'memory'];
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export interface Output {
  key: string;
  kind: 'file' | 'image' | 'artifact';
  /** A file's name, "Image" or the artifact's kind. */
  label: string;
  /** A file's folder, or where a picture or artifact came from. */
  detail?: string;
  path?: string;
  /** The call that wrote it: the row in the transcript to open. */
  toolUseId?: string;
  /** What a Write put in the file, for its preview. */
  content?: string;
  image?: { mediaType: string; data?: string; url?: string };
  /** An html or svg page: it opens in the preview. */
  page?: { lang: 'html' | 'svg'; code: string };
  at: number;
}

const WRITES = /^(Write|Edit|MultiEdit|NotebookEdit|write_file|edit_file|str_replace_editor|create_file)$/;

/** html and svg blocks preview; an xml block previews when its first element is <svg> (as conversation/ChatMarkdown.tsx). */
function pageLang(lang: string | undefined, code: string): 'html' | 'svg' | undefined {
  if (lang === 'html' || lang === 'htm') return 'html';
  if (lang === 'svg') return 'svg';
  if (lang === 'xml' && /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(code)) return 'svg';
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function folderOf(path: string): string | undefined {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  parts.pop();
  return parts.length ? parts.slice(-2).join('/') : undefined;
}

/**
 * The files the session wrote (one row per file, the last write wins),
 * then the pictures its tools and replies made and the html and svg pages
 * in its replies, newest first.
 */
export function sessionOutputs(messages: readonly Message[]): Output[] {
  const files = new Map<string, Output>();
  const rest: Output[] = [];
  const failed = new Set<string>();
  // only a ShareFile call's result is a file card; meta.file on any other tool's result is not
  const shares = new Set<string>();
  for (const m of messages)
    for (const b of m.content) {
      if (b.type === 'tool_result' && b.isError) failed.add(b.toolUseId);
      if (b.type === 'tool_use' && b.name === 'ShareFile') shares.add(b.id);
    }
  for (const m of messages) {
    let n = 0;
    for (const b of m.content as ContentBlock[]) {
      n++;
      if (b.type === 'tool_use' && WRITES.test(b.name) && !failed.has(b.id)) {
        const path = str(b.input.file_path) ?? str(b.input.path) ?? str(b.input.notebook_path);
        if (!path) continue;
        const content = str(b.input.content);
        const lang = content ? pageLang(path.split('.').pop()?.toLowerCase(), content) : undefined;
        files.delete(path);
        files.set(path, { key: `f:${path}`, kind: 'file', label: fileName(path), detail: folderOf(path), path, toolUseId: b.id, ...(content ? { content } : {}), ...(lang && content ? { page: { lang, code: content } } : {}), at: m.createdAt });
      } else if (b.type === 'tool_result' && !b.isError && shares.has(b.toolUseId) && typeof (b.meta?.file as { path?: unknown } | undefined)?.path === 'string') {
        // a ShareFile card: also files Bash made, which no Write shows; a Write of the same file keeps its preview
        const path = (b.meta!.file as { path: string }).path;
        const prev = files.get(path);
        files.delete(path);
        files.set(path, { ...prev, key: `f:${path}`, kind: 'file', label: fileName(path), detail: folderOf(path), path, toolUseId: b.toolUseId, at: m.createdAt });
      } else if (b.type === 'tool_result' && Array.isArray(b.content)) {
        b.content.forEach((c, i) => {
          if (c.type === 'image') rest.push({ key: `i:${b.toolUseId}:${i}`, kind: 'image', label: 'Image', detail: 'From a tool', image: { mediaType: c.mediaType, data: c.data, url: c.url }, toolUseId: b.toolUseId, at: m.createdAt });
        });
      } else if (b.type === 'image' && m.role === 'assistant') {
        rest.push({ key: `i:${m.id}:${n}`, kind: 'image', label: 'Image', detail: 'In a reply', image: { mediaType: b.mediaType, data: b.data, url: b.url }, at: m.createdAt });
      } else if (b.type === 'text' && m.role === 'assistant' && b.text.includes('```')) {
        const re = /```([\w-]*)[^\n]*\n([\s\S]*?)```/g;
        let f: RegExpExecArray | null;
        let k = 0;
        while ((f = re.exec(b.text))) {
          const lang = pageLang(f[1]?.toLowerCase() || undefined, f[2]);
          if (!lang) continue;
          const title = /<title>([^<]{1,80})<\/title>/i.exec(f[2])?.[1]?.trim();
          rest.push({ key: `a:${m.id}:${n}:${k++}`, kind: 'artifact', label: title || (lang === 'svg' ? 'SVG drawing' : 'HTML page'), detail: 'In a reply', page: { lang, code: f[2] }, at: m.createdAt });
        }
      }
    }
  }
  return [...files.values(), ...rest].sort((a, b) => b.at - a.at);
}

/** "3 files, 1 image", "None yet". */
export function outputsWord(list: readonly Output[]): string {
  const files = list.filter((o) => o.kind === 'file').length;
  const images = list.filter((o) => o.kind === 'image').length;
  const pages = list.filter((o) => o.kind === 'artifact').length;
  const parts = [files && `${files} ${files === 1 ? 'file' : 'files'}`, images && `${images} ${images === 1 ? 'image' : 'images'}`, pages && `${pages} ${pages === 1 ? 'page' : 'pages'}`].filter(Boolean);
  return parts.length ? parts.join(', ') : 'None yet';
}

// ---------------------------------------------------------------------------
// Background shells
// ---------------------------------------------------------------------------

export type ShellState = 'running' | 'completed' | 'failed' | 'killed';

export interface BackgroundShell {
  /** "bash_2". */
  id: string;
  command: string;
  description?: string;
  startedAt: number;
  state: ShellState;
  toolUseId: string;
}

const SHELL_STATES: readonly ShellState[] = ['running', 'completed', 'failed', 'killed'];

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join('\n');
  return '';
}

/**
 * The shells the session started with Bash run_in_background, with the
 * last state BashOutput or KillShell reported: running until one says it
 * ended. The one started first first.
 */
export function backgroundShells(messages: readonly Message[]): BackgroundShell[] {
  const byId = new Map<string, BackgroundShell>();
  const calls = new Map<string, { name: string; input: Record<string, unknown>; at: number }>();
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'tool_use') calls.set(b.id, { name: b.name, input: b.input, at: m.createdAt });
      else if (b.type === 'tool_result') {
        const call = calls.get(b.toolUseId);
        if (!call) continue;
        const meta = b.meta ?? {};
        const said = textOf(b.content);
        if (call.name === 'Bash' && call.input.run_in_background && !b.isError) {
          const id = str(meta.shellId) ?? /\bid (bash_\d+)/.exec(said)?.[1];
          if (id) byId.set(id, { id, command: str(call.input.command) ?? '', ...(str(call.input.description) ? { description: str(call.input.description) } : {}), startedAt: call.at, state: 'running', toolUseId: b.toolUseId });
        } else if (call.name === 'BashOutput' || call.name === 'KillShell') {
          const id = str(meta.shellId) ?? str(call.input.bash_id) ?? str(call.input.shell_id);
          const sh = id ? byId.get(id) : undefined;
          if (!sh) continue;
          const status = SHELL_STATES.find((s) => s === meta.status);
          if (call.name === 'KillShell' && !b.isError && /^Killed\b/.test(said)) sh.state = 'killed';
          else if (status) sh.state = status;
        }
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.startedAt - b.startedAt);
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** How full the context is, 0 to 100, from what the last reply sent; undefined until measured. */
export function contextPercent(used: number, window: number | undefined): number | undefined {
  if (!used || !window) return undefined;
  return Math.min(100, Math.max(used > 0 ? 1 : 0, Math.round((used / window) * 100)));
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

/**
 * What it cost, in a word: the bill, "plan" when a plan served it (worth more
 * than billed) or the model has no per-token price (a harness, a free
 * catalog entry, an unknown model), "local" for a model on this machine.
 */
export function costWord(stats: Valued, model: string | undefined, prices?: { inputPrice: number; outputPrice: number }): string {
  if (stats.costUsd) return usd(stats.costUsd);
  if (model && /^(ollama|lmstudio|llamacpp|local)\//.test(model)) return 'local';
  if (planServed(stats) || harnessId(model) || !prices || (!prices.inputPrice && !prices.outputPrice)) return 'plan';
  return usd(0);
}

/**
 * A workflow agent's or subagent's bill in a word. Their rows carry no API
 * value, so a call that used tokens and billed nothing was paid by a plan
 * (or ran locally); never "$0". Nothing before it used any.
 */
export function callCostWord(costUsd: number, tokens: number, model: string | undefined): string {
  if (costUsd) return usd(costUsd);
  if (!tokens) return '';
  return model && /^(ollama|lmstudio|llamacpp|local)\//.test(model) ? 'local' : 'plan';
}

/** The agent's state in the words the rest of the app uses (the session list's for a limit). */
export function stateWord(status: SessionStatus | undefined, resumeAt?: number): { word: string; tone: 'live' | 'warn' | 'fault' | 'dim' } {
  if (status === 'running') return { word: 'running', tone: 'live' };
  if (status === 'waiting_approval' || status === 'waiting_input') return { word: 'waiting on you', tone: 'warn' };
  if (status === 'waiting_reset') return { word: resumeAt ? `resumes ${hhmm(resumeAt)}` : 'waiting for reset', tone: 'dim' };
  if (status === 'paused') return { word: 'paused', tone: 'dim' };
  if (status === 'error') return { word: 'failed', tone: 'fault' };
  return { word: 'idle', tone: 'dim' };
}

export interface StatusInput {
  model?: string;
  /** The plan or key it runs on ("neu-claude, Max 20x"), when known. */
  plan?: string;
  /** Context used, 0 to 100; undefined until measured. */
  contextPct?: number;
  tokens: number;
  cost: string;
}

/**
 * The parts of an agent's status line, like the terminal app's second row:
 * "Opus 5.5", "neu-claude, Max 20x", "12% context", "48K tokens", "plan".
 * The state word goes after them, in its tone. Parts not known are left out.
 */
export function statusParts(s: StatusInput): string[] {
  return [modelName(s.model), s.plan ? `on ${s.plan}` : '', s.contextPct !== undefined ? `${s.contextPct}% context` : '', s.tokens ? `${compact(s.tokens)} tokens` : '', s.tokens || s.cost !== usd(0) ? s.cost : ''].filter(Boolean);
}
