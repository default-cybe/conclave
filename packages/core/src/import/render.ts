/**
 * What the learning job reads of a past session (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 1.7).
 *
 * Rows come in Codex's tier order: the owner's words verbatim, the final
 * assistant text of each turn, assistant commentary, then tool evidence
 * (at most 2k tokens per call and 20k in total). Rows are labelled [user],
 * [assistant], [tool] and [agent notice], so a task notice is never read as
 * the owner. Reads of .env, *.pem, id_* and credential files are dropped,
 * and <private>...</private> spans in the owner's text are removed.
 * Windows hold at most 30k tokens and split on user prompt boundaries.
 */
import type { ContentBlock, Message, TextBlock, ToolUseBlock } from '../types';
import { estimateTokens } from '../util/text';
import { redactSecrets } from '../memory/secrets';
import type { ImportedMessage } from '../importers/types';
import { originOf } from '../importers/types';

export const RENDER_LIMITS = {
  windowTokens: 30_000,
  toolCallTokens: 2_000,
  toolTotalTokens: 20_000,
  noticeChars: 600,
};

type AnyMessage = ImportedMessage | Message;

/** Tier 1 owner, 2 final answer, 3 commentary, 4 tool evidence, 5 notice. Lower tiers are cut first. */
interface RenderRow {
  tier: 1 | 2 | 3 | 4 | 5;
  text: string;
  /** A tool row whose output came from the web. */
  web?: boolean;
}

const ROLE_OF_TIER: Record<RenderRow['tier'], RowRole> = { 1: 'user', 2: 'assistant', 3: 'assistant', 4: 'tool', 5: 'notice' };

const roleOf = (r: RenderRow): RowRole => (r.web ? 'web' : ROLE_OF_TIER[r.tier]);

const WEB_TOOL = /(^|[_-])(web_?fetch|web_?search|fetch|search_web|browse|browser|scrape|crawl|http_?get|url)([_-]|$)|^web/i;
const WEB_COMMAND = /(^|[;&|(]\s*)(curl|wget|lynx|w3m|http|xh|aria2c)\b/;

/** A tool call whose output is a web page or search results. */
export function readsWeb(t: ToolUseBlock): boolean {
  if (WEB_TOOL.test(t.name)) return true;
  const inp = (t.input ?? {}) as Record<string, unknown>;
  const cmd = Array.isArray(inp.command) ? inp.command.join(' ') : typeof inp.command === 'string' ? inp.command : typeof inp.cmd === 'string' ? inp.cmd : '';
  return !!cmd && WEB_COMMAND.test(cmd.trim());
}

/**
 * A row label at the start of a line inside a row's text ("[user] ..." in a
 * fetched page or a pasted transcript) is neutralized, so text that is not
 * the owner's can never pass for an owner row, to the model or to the checks.
 */
export function neutralizeLabels(text: string): string {
  return text.replace(/^[ \t]*\[(user|assistant|tool|agent notice)\]/gim, '($1)');
}

interface Turn {
  rows: RenderRow[];
  seqs: number[];
}

/**
 * Which kind of row a quote came from, for the checks: the owner, the
 * assistant, a tool the agent ran, a fetched web page or web search (never
 * evidence for a memory: anyone can write a page), or an agent notice.
 */
export type RowRole = 'user' | 'assistant' | 'tool' | 'web' | 'notice';

export interface WindowRow {
  role: RowRole;
  text: string;
}

export interface RenderedWindow {
  text: string;
  tokens: number;
  /** The window's rows, each as rendered with who wrote it, so a check can ask where a quote came from. */
  rows: WindowRow[];
  /** Seq numbers of the messages in it (Conclave sessions) or their index (sources). */
  from: number;
  to: number;
}

const SENSITIVE_PATH = /(^|[\\/\s'"=])(\.env(\.[\w.-]+)?|[\w.-]+\.pem|id_(rsa|dsa|ecdsa|ed25519)[\w.-]*|\.netrc|\.pgpass|\.npmrc|\.pypirc|credentials(\.json)?|secrets?\.(json|ya?ml|toml|env)|[\w.-]+\.key|\.git-credentials|kubeconfig)($|[\s'"\\/;|&)])/i;

/** A tool call that reads a secret file: its call and its result are left out entirely. */
export function readsSecretFile(t: ToolUseBlock): boolean {
  const inp = t.input ?? {};
  const fields = ['file_path', 'path', 'filePath', 'notebook_path', 'pattern', 'command', 'cmd', 'input', 'arguments'];
  for (const f of fields) {
    const v = (inp as Record<string, unknown>)[f];
    const s = Array.isArray(v) ? v.join(' ') : typeof v === 'string' ? v : undefined;
    if (s && SENSITIVE_PATH.test(` ${s} `)) return true;
  }
  return false;
}

/** Remove <private>...</private> spans, nested ones included. An unclosed tag hides the rest. */
export function stripPrivate(text: string): string {
  if (!/<private>/i.test(text)) return text;
  let out = '';
  let depth = 0;
  const re = /<(\/?)private>/gi;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (depth === 0) out += text.slice(last, m.index);
    if (m[1]) depth = Math.max(0, depth - 1);
    else depth++;
    last = m.index + m[0].length;
  }
  if (depth === 0) out += text.slice(last);
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => (b as TextBlock).text)
    .join('\n')
    .trim();
}

function resultText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : '')).join('\n');
  return '';
}

function clipTokens(text: string, tokens: number): string {
  const max = tokens * 4;
  return text.length <= max ? text : `${text.slice(0, max - 20)} [cut]`;
}

function callLabel(t: ToolUseBlock): string {
  const inp = t.input as Record<string, unknown>;
  const pick = inp.command ?? inp.cmd ?? inp.pattern ?? inp.query ?? inp.file_path ?? inp.path ?? inp.url ?? inp.description;
  const arg = Array.isArray(pick) ? pick.join(' ') : typeof pick === 'string' ? pick : '';
  return arg ? `${t.name}(${arg.replace(/\s+/g, ' ').slice(0, 200)})` : t.name;
}

/** Split messages into turns: each starts at a prompt the owner typed. */
function turns(messages: AnyMessage[]): Turn[] {
  const out: Turn[] = [];
  let cur: Turn = { rows: [], seqs: [] };
  let toolBudget = RENDER_LIMITS.toolTotalTokens;
  const calls = new Map<string, ToolUseBlock>();
  const hidden = new Set<string>();
  const flush = () => {
    if (cur.rows.length) {
      // the last assistant text of a turn is its answer; earlier ones are commentary
      for (let i = cur.rows.length - 1; i >= 0; i--) {
        if (cur.rows[i].tier === 3) {
          cur.rows[i].tier = 2;
          break;
        }
      }
      out.push(cur);
    }
    cur = { rows: [], seqs: [] };
  };
  messages.forEach((m, idx) => {
    const seq = 'seq' in m ? m.seq : idx;
    if (m.kind === 'notice' || m.kind === 'summary') return;
    if (m.role === 'user') {
      const origin = originOf(m);
      const text = textOf(m.content);
      if (m.kind === 'aside' || origin === 'task' || origin === 'peer') {
        if (text) cur.rows.push({ tier: 5, text: `[agent notice] ${neutralizeLabels(text.slice(0, RENDER_LIMITS.noticeChars))}` });
        cur.seqs.push(seq);
        return;
      }
      if (origin === 'human' && text) {
        flush();
        cur.rows.push({ tier: 1, text: `[user] ${neutralizeLabels(stripPrivate(text))}` });
        cur.seqs.push(seq);
        return;
      }
      // tool results
      for (const b of m.content) {
        if (b.type !== 'tool_result') continue;
        if (hidden.has(b.toolUseId)) continue;
        const call = calls.get(b.toolUseId);
        if (toolBudget <= 0) continue;
        const body = clipTokens(resultText(b.content).trim(), Math.min(RENDER_LIMITS.toolCallTokens, toolBudget));
        const row = `[tool] ${call ? callLabel(call) : 'result'}${b.isError ? ' failed' : ''}: ${neutralizeLabels(body)}`;
        toolBudget -= estimateTokens(row);
        cur.rows.push({ tier: 4, text: row, ...(call && readsWeb(call) ? { web: true } : {}) });
      }
      cur.seqs.push(seq);
      return;
    }
    // assistant
    for (const b of m.content) {
      if (b.type === 'text' && b.text.trim()) cur.rows.push({ tier: 3, text: `[assistant] ${neutralizeLabels(b.text.trim())}` });
      else if (b.type === 'tool_use') {
        if (readsSecretFile(b)) hidden.add(b.id);
        else calls.set(b.id, b);
      }
    }
    cur.seqs.push(seq);
  });
  flush();
  return out;
}

function turnRows(t: Turn, maxTier: number): RenderRow[] {
  return t.rows.filter((r) => r.tier <= maxTier || r.tier === 5);
}

function turnText(t: Turn, maxTier: number): string {
  return turnRows(t, maxTier)
    .map((r) => r.text)
    .join('\n');
}



/**
 * Render a session into windows for the learning job. Secrets are redacted
 * once more on the way out; the evidence check runs against this text.
 */
export function renderWindows(messages: AnyMessage[], maxTokens = RENDER_LIMITS.windowTokens): RenderedWindow[] {
  const out: RenderedWindow[] = [];
  let buf: string[] = [];
  let rows: WindowRow[] = [];
  let tokens = 0;
  let from = Infinity;
  let to = -Infinity;
  const close = () => {
    if (!buf.length) return;
    const text = buf.join('\n\n');
    out.push({ text, tokens: estimateTokens(text), rows, from, to });
    buf = [];
    rows = [];
    tokens = 0;
    from = Infinity;
    to = -Infinity;
  };
  for (const t of turns(messages)) {
    let tier = 4;
    let text = redactSecrets(turnText(t, 4));
    // one turn bigger than a window: drop tool evidence, then commentary, then cut it
    if (estimateTokens(text) > maxTokens) text = redactSecrets(turnText(t, (tier = 3)));
    if (estimateTokens(text) > maxTokens) text = redactSecrets(turnText(t, (tier = 2)));
    if (estimateTokens(text) > maxTokens) text = clipTokens(text, maxTokens - 50);
    const n = estimateTokens(text);
    if (tokens + n > maxTokens) close();
    buf.push(text);
    for (const r of turnRows(t, tier)) rows.push({ role: roleOf(r), text: redactSecrets(r.text) });
    tokens += n;
    // a loop, not Math.min(...seqs): one turn of a long agent run can hold more messages than a call takes arguments
    for (const q of t.seqs) {
      if (q < from) from = q;
      if (q > to) to = q;
    }
  }
  close();
  return out;
}

/** Tokens the learning job would read for these messages (the estimate and the scan use it). */
export function renderedTokens(messages: AnyMessage[]): number {
  return renderWindows(messages).reduce((n, w) => n + w.tokens, 0);
}

/** Rows of a rendered window from its text (labels start rows; bodies never start a line with one). */
export function rowsOf(text: string): WindowRow[] {
  const out: WindowRow[] = [];
  const label: Record<string, RowRole> = { user: 'user', assistant: 'assistant', tool: 'tool', 'agent notice': 'notice' };
  for (const line of text.split('\n')) {
    const m = /^\[(user|assistant|tool|agent notice)\]/.exec(line);
    if (m) out.push({ role: label[m[1]], text: line });
    else if (out.length) out[out.length - 1].text += `\n${line}`;
  }
  return out;
}

/** Whitespace and case folded, for the evidence check. */
export function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
}
