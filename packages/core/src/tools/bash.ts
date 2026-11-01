import { randomBytes } from 'node:crypto';
import type { Tool, ToolContext, ToolOutput } from './types';
import { isReadOnlyCommand, suggestBashRule } from './bash-rules';
import { shellRegistry, type BackgroundShell } from './shells';
import { defuseFrameworkTags } from '../session/untrusted';
import { isHeadless } from '../session/runner';
import { clampInt, fail, outputBudget, truncateMiddleOut } from './util';
import { KEEPS, KIND_NAMES, reduceOutput } from './compress';

export interface BashInput {
  command: string;
  timeout?: number;
  description?: string;
  run_in_background?: boolean;
}

export const BASH_DEFAULT_TIMEOUT_MS = 120_000;
export const BASH_MAX_TIMEOUT_MS = 600_000;
export const BASH_MAX_OUTPUT_CHARS = 30_000;
const MACHINE_OUTPUT_CAP = 4 * 1024 * 1024;
const PROGRESS_FLUSH_MS = 250;

const DESCRIPTION = `Run a shell command (bash -c) on the session's machine and return its combined stdout and stderr.

- The working directory persists between calls; environment variables and shell functions do not. Prefer absolute paths to cd.
- timeout is in milliseconds (default ${BASH_DEFAULT_TIMEOUT_MS}, max ${BASH_MAX_TIMEOUT_MS}). Give a 5 to 10 word description of what the command does, e.g. "Run unit tests".
- Output over ${BASH_MAX_OUTPUT_CHARS} characters keeps what matters (a test report keeps its counts and failures, a log its error lines) and is then cut in the middle; the full output stays readable with ReadToolOutput. A non-zero exit code is reported at the end.
- There is no terminal and no stdin. Never use interactive commands or flags (git rebase -i, git add -i, editors, pagers, prompts); pass flags such as --yes instead.
- Set run_in_background for long-running processes (dev servers, watchers, long builds). You get a shell id at once; read its output with BashOutput and stop it with KillShell. Do not append & and do not sleep to wait for it.
- Run independent commands as parallel Bash calls. Chain dependent ones in one call with && (or ; when later steps should run anyway). Quote paths that contain spaces.
- Use Bash to build, test, and run git and package managers. For files use the dedicated tools: Glob instead of find or ls, Grep instead of grep or rg, Read instead of cat, head or tail, Edit or Write instead of sed, awk, echo or heredocs.

Git:
- Commit only when the user asks. Never change git config, force push or skip hooks (--no-verify) unless the user asks.
- Before committing, check git status and git diff and match the repository's message style. Stage specific files, and never commit secrets (.env, credentials).
- Commits are authored by the user's own git identity only. Never set an AI as author or committer, and never add a Co-authored-by line for an AI. End every commit message with one trailer line naming Conclave and your model id as shown in your environment: Committed-by: Conclave (provider/model).
- Pass the message through a heredoc so formatting survives: git commit -m "$(cat <<'EOF'
Message here.

Committed-by: Conclave (provider/model)
EOF
)". If a pre-commit hook changes files, make a new commit rather than amending.
- Use the gh CLI for GitHub work (pull requests, issues, checks).`;

/**
 * Wrap the command so the shell prints its final working directory after a
 * unique marker on the original stderr. Inside the command, stderr goes to
 * stdout so the model sees both streams in order.
 */
export function wrapCommand(marker: string): string {
  return [
    'exec 3>&2 2>&1',
    `trap '__cc_ec=$?; printf "\\n%s%s\\n" "${marker}" "$PWD" >&3; exit $__cc_ec' EXIT`,
    '__cc_cmd=$__CONCLAVE_CMD; unset __CONCLAVE_CMD',
    'eval "$__cc_cmd"',
  ].join('\n');
}

/** Pull the marker line out of a stream. Returns the cleaned text and the cwd if found. */
export function extractCwd(text: string, marker: string): { text: string; cwd?: string } {
  const idx = text.lastIndexOf(marker);
  if (idx === -1) return { text };
  const rest = text.slice(idx + marker.length);
  const nl = rest.indexOf('\n');
  const cwd = (nl === -1 ? rest : rest.slice(0, nl)).trim();
  let before = text.slice(0, idx);
  if (before.endsWith('\n')) before = before.slice(0, -1);
  const after = nl === -1 ? '' : rest.slice(nl + 1);
  return { text: before + after, cwd: cwd || undefined };
}

function bashEnv(ctx: ToolContext, extra?: Record<string, string>): Record<string, string> {
  return {
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    CONCLAVE: '1',
    CONCLAVE_SESSION_ID: ctx.sessionId,
    ...(extra ?? {}),
  };
}

async function runForeground(input: BashInput, ctx: ToolContext): Promise<ToolOutput> {
  const timeoutMs = clampInt(input.timeout, BASH_DEFAULT_TIMEOUT_MS, 1_000, BASH_MAX_TIMEOUT_MS);
  const marker = `__CONCLAVE_CWD_${randomBytes(6).toString('hex')}__`;

  let pending = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    if (!pending) return;
    const text = pending;
    pending = '';
    try {
      ctx.progress(text);
    } catch {
      /* UI listener errors are not the command's problem */
    }
  };

  const res = await ctx.machine.exec(wrapCommand(marker), {
    cwd: ctx.cwd,
    env: bashEnv(ctx, { __CONCLAVE_CMD: input.command }),
    timeoutMs,
    signal: ctx.signal,
    maxOutputBytes: MACHINE_OUTPUT_CAP,
    onOutput: (chunk, stream) => {
      if (stream !== 'stdout') return;
      pending += chunk;
      timer ??= setTimeout(flush, PROGRESS_FLUSH_MS);
    },
  });
  if (timer) clearTimeout(timer);
  flush();

  const err = extractCwd(res.stderr, marker);
  const out = extractCwd(res.stdout, marker);
  const newCwd = err.cwd ?? out.cwd;
  let full = out.text;
  if (err.text.trim()) full = full ? `${full.replace(/\n$/, '')}\n${err.text}` : err.text;
  full = full.replace(/\s+$/, '');

  const meta: ToolOutput['meta'] = { exitCode: res.exitCode ?? undefined, durationMs: res.durationMs };
  if (newCwd && newCwd !== ctx.cwd) meta.cwd = newCwd;

  // a long output is reduced by its kind before the middle cut (tools/compress), so a failure in the middle stays
  const budget = outputBudget(ctx, BASH_MAX_OUTPUT_CHARS);
  const reduced = full.length > budget ? reduceOutput(full, budget) : undefined;
  const cut = truncateMiddleOut(reduced?.text ?? full, budget);
  let text = cut.text;
  if (cut.truncated || reduced?.reduced) {
    meta.truncated = true;
    const how = reduced?.reduced ? `was reduced as ${KIND_NAMES[reduced.kind]} (kept: ${KEEPS[reduced.kind]})${cut.truncated ? ', then cut in the middle' : ''}` : 'was cut in the middle';
    try {
      const id = ctx.host.saveOutput(ctx.sessionId, 'Bash', full);
      meta.outputId = id;
      text += `\n\n(Output was ${full.length} characters and ${how}. Full output: ReadToolOutput with id "${id}"; pass query or grep to search it.)`;
    } catch {
      text += `\n\n(Output was ${full.length} characters and ${how}.)`;
    }
  }

  const notes: string[] = [];
  if (res.timedOut) notes.push(`Command timed out after ${Math.round(timeoutMs / 1000)}s and was killed. For long-running work use run_in_background.`);
  else if (res.aborted) notes.push('Command was interrupted.');
  else if (res.exitCode !== 0) notes.push(res.exitCode === null ? 'Command was killed by a signal.' : `Exit code ${res.exitCode}`);
  if (meta.cwd) notes.push(`Working directory is now ${meta.cwd}`);
  // a moved session: the command is never rewritten, but the model hears where the old folder is now
  const old = ctx.pathMap?.roots.find((r) => input.command.includes(r.from));
  if (old) notes.push(`Note: ${old.from} is where this session's folder was before it moved. On this device it is ${old.to}.`);

  if (!text) text = res.exitCode === 0 && !res.timedOut ? '(no output)' : '';
  const content = [text, ...notes].filter(Boolean).join('\n\n');
  return { content, isError: res.timedOut || res.aborted || res.exitCode !== 0, meta };
}

const BLOCKING_WAIT_SLEEP_S = 30;
// the whole command is one wait: no operator, quote-free redirect, substitution or second line, so nothing else rides along
const BLOCKING_WAIT_RE = /^(gh run watch|gh pr checks|watch|sleep)(?:[ \t]([^;&|<>`$()\n]*))?$/;
const SLEEP_UNIT_S: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** A command that is nothing but a wait (CI watch, watch, long sleep): it runs in the background so queued messages are read. */
export function isBlockingWait(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  const m = BLOCKING_WAIT_RE.exec(command.trim());
  if (!m) return false;
  const args = m[2] ?? '';
  if (m[1] === 'gh pr checks') return /(?:^|\s)--watch(?:\s|$)/.test(args);
  if (m[1] !== 'sleep') return true;
  let secs = 0;
  for (const a of args.split(/\s+/).filter(Boolean)) {
    const d = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(a);
    if (d) secs += Number(d[1]) * (SLEEP_UNIT_S[d[2] || 's'] as number);
  }
  return secs > BLOCKING_WAIT_SLEEP_S;
}

/** What the session hears when a moved wait ends: its status and the end of its output, defused like any tool text. */
function endedNote(shell: BackgroundShell): string {
  const i = shell.info;
  const tail = `${shell.stdout.all()}${shell.stderr.all()}`.replace(/\s+$/, '').slice(-2_000);
  const how = i.exitCode === null ? i.status : `${i.status}, exit code ${i.exitCode}`;
  return `The background command "${i.command.slice(0, 100)}" (${i.id}) ended: ${how}.${tail ? `\nEnd of its output:\n${defuseFrameworkTags(tail)}` : ''}`;
}

function runBackground(input: BashInput, ctx: ToolContext, moved = false): ToolOutput {
  try {
    const shell = shellRegistry.start({
      sessionId: ctx.sessionId,
      machine: ctx.machine,
      command: input.command,
      cwd: ctx.cwd,
      description: input.description,
      env: bashEnv(ctx),
      // a moved wait keeps the foreground cap as its kill deadline and tells the session when it ends
      ...(moved
        ? {
            timeoutMs: clampInt(input.timeout, BASH_MAX_TIMEOUT_MS, 1_000, BASH_MAX_TIMEOUT_MS),
            onEnd: (s: BackgroundShell) => ctx.host.shellEnded?.(ctx.sessionId, endedNote(s)),
          }
        : {}),
    });
    return {
      content: `Command running in background with id ${shell.info.id}. Use BashOutput with bash_id "${shell.info.id}" to read its output and KillShell to stop it.`,
      meta: { shellId: shell.info.id, background: true },
    };
  } catch (err) {
    return fail(`Could not start background command: ${(err as Error).message}`);
  }
}

export const BashTool: Tool<BashInput> = {
  name: 'Bash',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command to run' },
      timeout: { type: 'number', description: `Timeout in milliseconds (default ${BASH_DEFAULT_TIMEOUT_MS}, max ${BASH_MAX_TIMEOUT_MS})` },
      description: { type: 'string', description: 'What the command does, in 5-10 words' },
      run_in_background: { type: 'boolean', description: 'Run without waiting; read output later with BashOutput' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  readOnly: (input) => !input?.run_in_background && !isBlockingWait(input?.command) && isReadOnlyCommand(input?.command),
  ruleContent: (input) => (typeof input.command === 'string' ? input.command.trim() : undefined),
  summarize: (input) => input.description?.trim() || `Run: ${String(input.command ?? '').replace(/\s+/g, ' ').slice(0, 100)}`,
  suggestRule: (input) => suggestBashRule(input.command),
  async run(input, ctx) {
    if (typeof input.command !== 'string' || !input.command.trim()) return fail('command is required.');
    if (input.run_in_background) return runBackground(input, ctx);
    // only where the owner's queued messages wait behind the turn; a subagent, workflow step or routine needs the wait's result before it reports
    if (isBlockingWait(input.command) && !isHeadless(ctx.session, ctx.session.mode, ctx.depth)) {
      const started = runBackground(input, ctx, true);
      if (started.isError) return started;
      return { ...started, content: `Note: this command only waits, so it was moved to the background to keep the chat free for queued messages.\n${started.content}` };
    }
    return runForeground(input, ctx);
  },
};
